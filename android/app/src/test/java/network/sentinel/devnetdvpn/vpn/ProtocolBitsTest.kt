package network.sentinel.devnetdvpn.vpn

import org.junit.Assert.assertEquals
import org.junit.Test

// Same values as tests/unit/daemon-layout.test.ts (cb33 table and layout).
class ProtocolBitsTest {
    @Test
    fun decodesEachOfTheSixBits() {
        val want = listOf(1 to "wireguard", 2 to "v2ray", 4 to "openvpn", 8 to "amneziawg", 16 to "xray", 32 to "hysteria2")
        for ((bit, name) in want) assertEquals(bit.toString(), listOf(name), ProtocolBits.names(bit))
        assertEquals(want.map { it.second }, ProtocolBits.names(63))
        // a node with wireguard + hysteria2 (the old table read 33 as wireguard + amneziawg)
        assertEquals(listOf("wireguard", "hysteria2"), ProtocolBits.names(33))
    }

    @Test
    fun runsTheC0InstanceLikeTheJsSide() {
        assertEquals(listOf("run", "--instance", "c0", "--home", "/h"), DaemonProcess.runArgs("/h"))
        assertEquals("sentinel-dvpnd", DaemonProcess.DAEMON_NAME)
        assertEquals("sentinel-dvpn", DaemonProcess.PRODUCT_DIR)
    }
}
