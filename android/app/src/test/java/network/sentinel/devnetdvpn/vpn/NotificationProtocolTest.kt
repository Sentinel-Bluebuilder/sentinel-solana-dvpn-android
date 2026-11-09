package network.sentinel.devnetdvpn.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationProtocolTest {
    @Test fun namesMatchTheScreens() {
        assertEquals("WireGuard", DvpnVpnService.protocolLabel("wireguard"))
        assertEquals("Hysteria2", DvpnVpnService.protocolLabel("HYSTERIA2"))
        assertEquals("something-new", DvpnVpnService.protocolLabel("something-new"))
    }

    @Test fun everyProtocolButWireGuardHasItsLogo() {
        for (p in listOf("amneziawg", "openvpn", "v2ray", "xray", "hysteria2")) assertNotNull(p, DvpnVpnService.protocolLogo(p))
        assertNull("WireGuard: name only (trademark policy)", DvpnVpnService.protocolLogo("wireguard"))
    }
}
