package network.sentinel.devnetdvpn.vpn

import java.io.FileDescriptor
import org.json.JSONArray
import org.json.JSONObject

// ─── Platform protocol (Kotlin side of sentinel-go-sdk/platform) ───
// One JSON line in, one JSON line out per connection. "establish" replies carry the TUN fd.
// Pure logic: the socket and VpnService live elsewhere so this is unit-tested on the JVM.

data class TunnelSpec(
    val session: String,
    val addrs: List<String>,
    val routes: List<String>,
    val excludeRoutes: List<String>,
    val dns: List<String>,
    val mtu: Int,
    val httpProxy: String?,
    /** dvpnd network.allow_lan: keep local networks out of the tunnel. */
    val allowLan: Boolean = false,
) {
    companion object {
        const val MIN_MTU = 1280
        const val MAX_MTU = 1500

        fun parse(o: JSONObject): TunnelSpec {
            val spec = TunnelSpec(
                session = o.optString("session", "vpn"),
                addrs = o.optJSONArray("addrs").strings(),
                routes = o.optJSONArray("routes").strings(),
                excludeRoutes = o.optJSONArray("exclude_routes").strings(),
                dns = o.optJSONArray("dns").strings(),
                mtu = o.optInt("mtu", MIN_MTU),
                httpProxy = o.optString("http_proxy", "").ifBlank { null },
                allowLan = o.optBoolean("allow_lan", false),
            )
            spec.validate()
            return spec
        }

        private fun JSONArray?.strings(): List<String> =
            if (this == null) emptyList() else (0 until length()).map { getString(it) }
    }

    fun validate() {
        require(addrs.isNotEmpty()) { "no interface address" }
        addrs.forEach { require(Cidr.parse(it) != null) { "bad address $it" } }
        routes.forEach { require(Cidr.parse(it) != null) { "bad route $it" } }
        excludeRoutes.forEach { require(Cidr.parse(it) != null) { "bad exclude route $it" } }
        dns.forEach { require(Cidr.isIp(it)) { "bad dns server $it" } }
        require(mtu in MIN_MTU..MAX_MTU) { "mtu $mtu outside $MIN_MTU..$MAX_MTU" }
    }
}

data class PlatformState(
    val connected: Boolean,
    val held: Boolean,
    val alwaysOn: Boolean,
    val lockdown: Boolean,
    val privateDns: String,
    val sdk: Int,
    val splitMode: String,
    val underlying: String,
    /**
     * The underlying network itself ("wifi#<handle>", "none"), not just its kind: every
     * reconnect (airplane off, Wi-Fi to mobile) gets a new handle, so dvpnd can tell the network
     * changed and rebind its tunnel sockets (Q0249).
     */
    val underlyingId: String = "",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("connected", connected).put("held", held)
        .put("always_on", alwaysOn).put("lockdown", lockdown)
        .put("private_dns", privateDns).put("sdk", sdk)
        .put("split_mode", splitMode).put("underlying", underlying)
        .put("underlying_id", underlyingId)
}

/** What the protocol needs from the VPN service. */
interface PlatformHost {
    /** Builds the interface; the host keeps it open and returns its descriptor to send. */
    fun establish(spec: TunnelSpec): FileDescriptor
    fun hold(hold: Boolean)
    fun release()
    fun state(): PlatformState
}

/** The reply line plus the descriptor to attach (establish only). */
data class PlatformReply(val line: String, val fd: FileDescriptor? = null)

object PlatformProtocol {
    fun handle(requestLine: String, host: PlatformHost): PlatformReply = try {
        val req = JSONObject(requestLine)
        when (val op = req.optString("op")) {
            "establish" -> {
                val spec = TunnelSpec.parse(req.getJSONObject("spec"))
                PlatformReply(ok().toString(), host.establish(spec))
            }
            "hold" -> {
                host.hold(req.getBoolean("hold"))
                PlatformReply(ok().toString())
            }
            "release" -> {
                host.release()
                PlatformReply(ok().toString())
            }
            "status" -> PlatformReply(ok().put("state", host.state().toJson()).toString())
            else -> PlatformReply(err("unknown op '$op'"))
        }
    } catch (e: Exception) {
        PlatformReply(err(e.message ?: e.javaClass.simpleName))
    }

    private fun ok() = JSONObject().put("ok", true)
    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()
}

/** Minimal CIDR / IP parsing without android.net (so the JVM tests run). */
object Cidr {
    data class Prefix(val addr: String, val bits: Int)

    fun parse(s: String): Prefix? {
        val parts = s.trim().split("/")
        if (parts.size != 2) return null
        val bits = parts[1].toIntOrNull() ?: return null
        val addr = parts[0]
        val max = when {
            isIpv4(addr) -> 32
            isIpv6(addr) -> 128
            else -> return null
        }
        return if (bits in 0..max) Prefix(addr, bits) else null
    }

    fun isIp(s: String) = isIpv4(s) || isIpv6(s)

    fun isIpv4(s: String): Boolean {
        val p = s.split(".")
        return p.size == 4 && p.all { it.isNotEmpty() && it.length <= 3 && it.all(Char::isDigit) && it.toInt() <= 255 }
    }

    fun isIpv6(s: String): Boolean {
        if (!s.contains(":") || s.count { it == ':' } > 7) return false
        if (s.indexOf("::") != s.lastIndexOf("::")) return false
        return s.split(":").all { it.length <= 4 && it.all { c -> c.isDigit() || c.lowercaseChar() in 'a'..'f' } }
    }
}
