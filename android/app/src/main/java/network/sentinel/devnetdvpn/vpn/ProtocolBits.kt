package network.sentinel.devnetdvpn.vpn

// ─── Protocol bits (node accounts' `protocols` mask) ───
// The same cb33 table as src/core/daemon/layout.ts PROTOCOL_BITS (sentinel-go-sdk <proto>/<proto>.go
// protocolBit on fork-cb33-1-rc). Before cb33 it was xray 4, openvpn 8, hysteria2 16, amneziawg 32;
// ProtocolBitsTest uses the same values as the JS test, so both fail the same way if either drifts.

object ProtocolBits {
    val TABLE: List<Pair<Int, String>> = listOf(
        1 to "wireguard",
        2 to "v2ray",
        4 to "openvpn",
        8 to "amneziawg",
        16 to "xray",
        32 to "hysteria2",
    )

    /** Protocol names set in [mask], in table order. */
    fun names(mask: Int): List<String> = TABLE.filter { (bit, _) -> mask and bit != 0 }.map { it.second }
}
