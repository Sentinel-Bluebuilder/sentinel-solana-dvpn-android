package network.sentinel.devnetdvpn.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RouteSplitTest {
    private val full = listOf("0.0.0.0/0", "::/0")
    private val dns = listOf("103.196.38.38", "103.196.38.39")

    @Test fun allKeepsTheTunnelRoutes() {
        assertEquals(RouteSplit.Plan(full, emptyList()), RouteSplit.plan(Split.MODE_ALL, setOf("10.0.0.0/8"), full, dns, true))
    }

    @Test fun includeRoutesOnlyTheChosenNetworksPlusDns() {
        val p = RouteSplit.plan(Split.MODE_INCLUDE, listOf("1.1.1.1", "203.0.113.1/32", "10.9.8.7/8"), full, dns, false)
        assertEquals(listOf("1.1.1.1/32", "203.0.113.1/32", "10.0.0.0/8", "103.196.38.38/32", "103.196.38.39/32"), p.routes)
        assertTrue(p.excludes.isEmpty())
    }

    @Test(expected = IllegalArgumentException::class) fun includeNeedsAnAddress() {
        RouteSplit.plan(Split.MODE_INCLUDE, emptyList(), full, dns, true)
    }

    @Test fun excludeUsesExcludeRouteOnNewAndroid() {
        val p = RouteSplit.plan(Split.MODE_EXCLUDE, listOf("1.1.1.1"), full, dns, true)
        assertEquals(full, p.routes)
        assertEquals(listOf("1.1.1.1/32"), p.excludes)
    }

    @Test fun excludeRoutesTheComplementOnOldAndroid() {
        val p = RouteSplit.plan(Split.MODE_EXCLUDE, listOf("128.0.0.0/1"), listOf("0.0.0.0/0"), dns, false)
        assertEquals(listOf("0.0.0.0/1"), p.routes)
        val q = RouteSplit.plan(Split.MODE_EXCLUDE, listOf("1.1.1.1"), listOf("0.0.0.0/0"), dns, false)
        assertEquals(32, q.routes.size) // one sibling per level from /1 down to /32
        assertTrue("1.1.1.1 must not be routed", q.routes.none { covers(it, "1.1.1.1") })
        assertTrue("1.1.1.0 must be routed", q.routes.any { covers(it, "1.1.1.0") })
        assertTrue("8.8.8.8 must be routed", q.routes.any { covers(it, "8.8.8.8") })
    }

    @Test fun subtractHandlesCoverAndDisjoint() {
        assertEquals(emptyList<String>(), RouteSplit.subtract("10.1.0.0/16", "10.0.0.0/8"))
        assertEquals(listOf("192.168.0.0/16"), RouteSplit.subtract("192.168.0.0/16", "10.0.0.0/8"))
        assertEquals(listOf("::/0"), RouteSplit.subtract("::/0", "10.0.0.0/8")) // other family untouched
        assertEquals(listOf("8000::/1"), RouteSplit.subtract("::/0", "::/1"))
    }

    @Test fun normaliseRejectsJunk() {
        assertEquals("10.0.0.0/8", RouteSplit.normalise(" 10.200.3.4/8 "))
        for (bad in listOf("example.com", "10.0.0.0/33", "1.2.3", "", "1.1.1.1/x", "'; rm -rf /")) {
            try {
                RouteSplit.normalise(bad)
                throw AssertionError("accepted $bad")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.isNotEmpty())
            }
        }
    }

    @Test
    fun allowLanKeepsLocalNetworksOutAndDnsIn() {
        val all = listOf("0.0.0.0/0", "::/0")
        // API 33+: native excludes, the private DNS server routed back in as a /32.
        val n = RouteSplit.plan(Split.MODE_ALL, emptyList(), all, listOf("10.8.0.1"), nativeExclude = true, allowLan = true)
        assertTrue(n.excludes.containsAll(RouteSplit.LAN))
        assertTrue("10.8.0.1/32" in n.routes)
        // Older Android: the complement — no route covers the LAN, the DNS host and the internet are covered.
        val o = RouteSplit.plan(Split.MODE_ALL, emptyList(), all, listOf("10.8.0.1"), nativeExclude = false, allowLan = true)
        assertTrue(o.excludes.isEmpty())
        val v4 = o.routes.filter { !it.contains(':') }
        assertTrue(v4.none { covers(it, "192.168.1.10") || covers(it, "10.0.2.2") || covers(it, "172.20.0.1") || covers(it, "169.254.1.1") })
        assertTrue(v4.any { covers(it, "8.8.8.8") } && v4.any { covers(it, "203.0.113.1") })
        assertTrue("10.8.0.1/32" in o.routes)
        assertTrue(o.routes.size <= RouteSplit.MAX_ROUTES)
        // Off: unchanged.
        assertEquals(RouteSplit.Plan(all, emptyList()), RouteSplit.plan(Split.MODE_ALL, emptyList(), all, emptyList(), nativeExclude = true))
    }

    @Test
    fun allowLanInIncludeModeDropsChosenLocalNetworks() {
        val p = RouteSplit.plan(Split.MODE_INCLUDE, listOf("192.168.5.0/24", "1.1.1.1"), listOf("0.0.0.0/0"), listOf("9.9.9.9"), nativeExclude = true, allowLan = true)
        assertTrue(p.routes.none { it.startsWith("192.168.") })
        assertTrue("1.1.1.1/32" in p.routes && "9.9.9.9/32" in p.routes)
    }

    // Q0343: a home LAN on global IPv6 (SLAAC /64) is local too; a LAN host reached by its global v6
    // address went into the tunnel.
    @Test
    fun allowLanKeepsTheOnLinkIpv6PrefixOut() {
        val all = listOf("0.0.0.0/0", "::/0")
        val slaac = "2a02:810d:4b3f:a100::/64"
        val lanHost = "2a02:810d:4b3f:a100:1c2d:3e4f:5a6b:7c8d"

        val n = RouteSplit.plan(Split.MODE_ALL, emptyList(), all, listOf("10.8.0.1"), nativeExclude = true, allowLan = true, onLinkV6 = listOf(slaac))
        assertTrue(slaac in n.excludes)

        val o = RouteSplit.plan(Split.MODE_ALL, emptyList(), all, listOf("10.8.0.1"), nativeExclude = false, allowLan = true, onLinkV6 = listOf(slaac))
        val v6 = o.routes.filter { it.contains(':') }
        assertTrue("the LAN host must not be routed", v6.none { covers6(it, lanHost) })
        assertTrue("other IPv6 still goes through the tunnel", v6.any { covers6(it, "2606:4700:4700::1111") })
        assertTrue("same /48, other /64: tunnel", v6.any { covers6(it, "2a02:810d:4b3f:a101::1") })
        assertTrue(o.routes.size <= RouteSplit.MAX_ROUTES)

        // allow_lan off: the on-link prefix changes nothing.
        assertEquals(RouteSplit.Plan(all, emptyList()), RouteSplit.plan(Split.MODE_ALL, emptyList(), all, emptyList(), nativeExclude = true, onLinkV6 = listOf(slaac)))
    }

    @Test
    fun onLinkPrefixesAreSanityChecked() {
        val got = RouteSplit.localNetworks(listOf("::/0", "2000::/3", "2a02:810d::1/64", "192.168.1.0/24", "fd00:1::/64", "junk", "2a02:810d::/64"), nativeExclude = true)
        // Kept: one /64 in network form. Dropped: a default route, prefixes shorter than /32, IPv4,
        // ones already in the fixed list (ULA), junk, repeats.
        assertEquals(RouteSplit.LAN + "2a02:810d::/64", got)
        // Old Android: at most MAX_ON_LINK_COMPLEMENT on-link prefixes (each costs ~bits routes).
        val many = (1..5).map { "2a02:810d:0:$it::/64" }
        assertEquals(RouteSplit.LAN.size + RouteSplit.MAX_ON_LINK_COMPLEMENT, RouteSplit.localNetworks(many, nativeExclude = false).size)
        assertEquals(RouteSplit.LAN.size + 5, RouteSplit.localNetworks(many, nativeExclude = true).size)
    }

    @Test
    fun ipv6PrintsInShortForm() {
        assertEquals("::", RouteSplit.compress6("0:0:0:0:0:0:0:0"))
        assertEquals("8000::", RouteSplit.compress6("8000:0:0:0:0:0:0:0"))
        assertEquals("::1", RouteSplit.compress6("0:0:0:0:0:0:0:1"))
        assertEquals("2001:db8:0:1:1:1:1:1", RouteSplit.compress6("2001:db8:0:1:1:1:1:1"))
        assertEquals("2001:0:0:1::1", RouteSplit.compress6("2001:0:0:1:0:0:0:1"))
        assertEquals("2001:db8::1:0:0:1", RouteSplit.compress6("2001:db8:0:0:1:0:0:1"))
    }

    private fun covers(cidr: String, ip: String): Boolean = RouteSplit.subtract("$ip/32", cidr).isEmpty()
    private fun covers6(cidr: String, ip: String): Boolean = RouteSplit.subtract("$ip/128", cidr).isEmpty()
}
