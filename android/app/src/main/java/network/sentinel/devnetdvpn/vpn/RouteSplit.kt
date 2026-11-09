package network.sentinel.devnetdvpn.vpn

import java.math.BigInteger
import java.net.InetAddress

// ─── Split tunnelling by destination (every protocol) ───
// all     = the tunnel's own routes (the whole internet)
// include = only the chosen networks go through the VPN (plus the VPN's DNS servers, so lookups
//           stay inside the tunnel)
// exclude = everything except the chosen networks. API 33+ uses VpnService.Builder.excludeRoute;
//           older Android gets the same result by routing the complement of the chosen networks.
// Pure JVM (no android.net) so the unit tests run off the device.

object RouteSplit {
    data class Plan(val routes: List<String>, val excludes: List<String>)

    const val MAX_ROUTES = 200

    /** Local networks left out when dvpnd's allow_lan is on: private, link-local and unique-local. */
    val LAN = listOf("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fe80::/10", "fc00::/7")

    /** On Android before 13 (no excludeRoute) each on-link prefix costs ~bits routes: at most this many. */
    const val MAX_ON_LINK_COMPLEMENT = 2

    /**
     * The local networks for allow_lan: the fixed private ranges plus the underlying network's on-link
     * IPv6 prefixes (Q0343: a home LAN on global IPv6, a SLAAC /64, is local too, but is not in any
     * private range, so a LAN host reached by its global v6 address went into the tunnel). Only IPv6
     * prefixes of /32 or longer are taken; anything else (a default route, junk) is ignored.
     */
    fun localNetworks(onLinkV6: Collection<String>, nativeExclude: Boolean): List<String> {
        val extra = onLinkV6.mapNotNull { s ->
            // Cidr.parse is null for junk (normalise would throw on it): junk is left out.
            Cidr.parse(s.trim())?.let { normalise(s) }?.takeIf { c ->
                c.contains(':') && c.substringAfter('/').toInt() >= 32 && LAN.none { subtract(c, it).isEmpty() }
            }
        }.distinct()
        return LAN + if (nativeExclude) extra else extra.take(MAX_ON_LINK_COMPLEMENT)
    }

    fun plan(
        mode: String, chosen: Collection<String>, routes: List<String>, dns: List<String>, nativeExclude: Boolean,
        allowLan: Boolean = false, onLinkV6: Collection<String> = emptyList(),
    ): Plan {
        val base = byMode(mode, chosen, routes, dns, nativeExclude)
        if (!allowLan) return base
        val lan = localNetworks(onLinkV6, nativeExclude)
        // The VPN's DNS servers stay inside the tunnel even when they are private addresses
        // (10.8.0.1 on many configs): a /32 route beats the excluded /8.
        val dnsHosts = dns.map(::host)
        return if (nativeExclude && mode != Split.MODE_INCLUDE) {
            Plan((base.routes + dnsHosts).distinct(), (base.excludes + lan).distinct())
        } else {
            val kept = base.routes.flatMap { r -> lan.fold(listOf(normalise(r))) { acc, c -> acc.flatMap { subtract(it, c) } } }
            Plan((kept + dnsHosts).distinct(), base.excludes)
        }
    }

    private fun byMode(mode: String, chosen: Collection<String>, routes: List<String>, dns: List<String>, nativeExclude: Boolean): Plan =
        when (mode) {
            Split.MODE_INCLUDE -> {
                require(chosen.isNotEmpty()) { "split by address is set to 'only these' but no address is chosen" }
                Plan((chosen.map(::normalise) + dns.map(::host)).distinct(), emptyList())
            }
            Split.MODE_EXCLUDE ->
                if (nativeExclude) Plan(routes, chosen.map(::normalise))
                else Plan(routes.flatMap { r -> chosen.fold(listOf(normalise(r))) { acc, c -> acc.flatMap { subtract(it, normalise(c)) } } }, emptyList())
            else -> Plan(routes, emptyList())
        }

    /** Checks one CIDR (or a bare IP = one host); returns it in network form, e.g. 10.1.2.3/8 → 10.0.0.0/8. */
    fun normalise(s: String): String {
        val text = s.trim()
        val p = Cidr.parse(if (text.contains("/")) text else host(text))
            ?: throw IllegalArgumentException("not an address or network: $s")
        val width = if (Cidr.isIpv4(p.addr)) 32 else 128
        return format(toInt(p.addr).and(mask(p.bits, width)), p.bits, width)
    }

    private fun host(ip: String): String {
        require(Cidr.isIp(ip)) { "not an IP address: $ip" }
        return if (Cidr.isIpv4(ip)) "$ip/32" else "$ip/128"
    }

    /** r minus c, as a list of CIDRs (r itself when they do not overlap). */
    fun subtract(r: String, c: String): List<String> {
        val a = Cidr.parse(r)!!
        val b = Cidr.parse(c)!!
        if (Cidr.isIpv4(a.addr) != Cidr.isIpv4(b.addr)) return listOf(r)
        val width = if (Cidr.isIpv4(a.addr)) 32 else 128
        val an = toInt(a.addr).and(mask(a.bits, width))
        val bn = toInt(b.addr).and(mask(b.bits, width))
        if (b.bits <= a.bits) {
            // c covers r entirely, or they are disjoint
            return if (an.and(mask(b.bits, width)) == bn) emptyList() else listOf(r)
        }
        if (bn.and(mask(a.bits, width)) != an) return listOf(r) // c is outside r
        // Walk from r down to c: at each level keep the half that does not contain c.
        val out = mutableListOf<String>()
        for (bits in a.bits + 1..b.bits) {
            val bit = BigInteger.ONE.shiftLeft(width - bits)
            val sibling = bn.and(mask(bits, width)).xor(bit)
            out += format(sibling, bits, width)
        }
        return out
    }

    private fun mask(bits: Int, width: Int): BigInteger =
        BigInteger.ONE.shiftLeft(width).subtract(BigInteger.ONE).xor(BigInteger.ONE.shiftLeft(width - bits).subtract(BigInteger.ONE))

    private fun toInt(addr: String): BigInteger = BigInteger(1, InetAddress.getByName(addr).address)

    private fun format(n: BigInteger, bits: Int, width: Int): String {
        val bytes = n.toByteArray().let { raw ->
            val len = width / 8
            ByteArray(len) { i -> raw.getOrElse(raw.size - len + i) { 0 } }
        }
        val host = InetAddress.getByAddress(bytes).hostAddress!!
        return "${if (width == 128) compress6(host) else host}/$bits"
    }

    /** RFC 5952 short form (Java prints 8000:0:0:0:0:0:0:0); the longest run of zero groups becomes "::". */
    internal fun compress6(full: String): String {
        val groups = full.substringBefore('%').split(':').map { it.trimStart('0').ifEmpty { "0" } }
        var bestStart = -1
        var bestLen = 1 // a single zero group stays "0"
        var i = 0
        while (i < groups.size) {
            if (groups[i] == "0") {
                var j = i
                while (j < groups.size && groups[j] == "0") j++
                if (j - i > bestLen) { bestStart = i; bestLen = j - i }
                i = j
            } else i++
        }
        if (bestStart < 0) return groups.joinToString(":")
        val head = groups.subList(0, bestStart).joinToString(":")
        val tail = groups.subList(bestStart + bestLen, groups.size).joinToString(":")
        return "$head::$tail"
    }
}
