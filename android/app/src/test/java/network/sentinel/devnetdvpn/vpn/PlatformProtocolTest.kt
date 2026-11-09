package network.sentinel.devnetdvpn.vpn

import java.io.FileDescriptor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlatformProtocolTest {
    private class FakeHost : PlatformHost {
        var established: TunnelSpec? = null
        var held = false
        var released = 0
        override fun establish(spec: TunnelSpec): FileDescriptor {
            established = spec
            return FileDescriptor()
        }
        override fun hold(hold: Boolean) { held = hold }
        override fun release() { released++ }
        override fun state() = PlatformState(true, held, true, false, "opportunistic", 35, "all", "wifi", "wifi#4242")
    }

    private fun reply(line: String, host: PlatformHost) = PlatformProtocol.handle(line, host)

    @Test fun establishParsesSpecAndAttachesFd() {
        val h = FakeHost()
        val r = reply(
            """{"op":"establish","spec":{"session":"wireguard","addrs":["10.8.0.2/32","fd00::2/128"],
               "routes":["0.0.0.0/0","::/0"],"dns":["1.1.1.1","2606:4700:4700::1111"],"mtu":1380}}""",
            h,
        )
        assertTrue(JSONObject(r.line).getBoolean("ok"))
        assertNotNull(r.fd)
        assertEquals(listOf("1.1.1.1", "2606:4700:4700::1111"), h.established!!.dns)
        assertEquals(1380, h.established!!.mtu)
        assertEquals(false, h.established!!.allowLan)
    }

    @Test fun establishCarriesAllowLan() {
        val h = FakeHost()
        reply(
            """{"op":"establish","spec":{"session":"xray","addrs":["10.8.0.2/32"],"routes":["0.0.0.0/0"],"mtu":1380,"allow_lan":true}}""",
            h,
        )
        assertEquals(true, h.established!!.allowLan)
    }

    @Test fun establishRejectsBadMtuWithoutCallingHost() {
        val h = FakeHost()
        val r = reply("""{"op":"establish","spec":{"addrs":["10.0.0.2/32"],"mtu":9000}}""", h)
        assertFalse(JSONObject(r.line).getBoolean("ok"))
        assertNull(r.fd)
        assertNull(h.established)
    }

    @Test fun establishRejectsBadAddress() {
        val r = reply("""{"op":"establish","spec":{"addrs":["10.0.0.300/32"],"mtu":1400}}""", FakeHost())
        assertTrue(JSONObject(r.line).getString("error").contains("bad address"))
    }

    @Test fun establishRejectsBadDns() {
        val r = reply("""{"op":"establish","spec":{"addrs":["10.0.0.2/32"],"dns":["dns.google"],"mtu":1400}}""", FakeHost())
        assertTrue(JSONObject(r.line).getString("error").contains("bad dns"))
    }

    @Test fun holdReleaseStatus() {
        val h = FakeHost()
        assertTrue(JSONObject(reply("""{"op":"hold","hold":true}""", h).line).getBoolean("ok"))
        assertTrue(h.held)
        reply("""{"op":"release"}""", h)
        assertEquals(1, h.released)
        val st = JSONObject(reply("""{"op":"status"}""", h).line).getJSONObject("state")
        assertTrue(st.getBoolean("held"))
        assertEquals(35, st.getInt("sdk"))
        assertEquals("opportunistic", st.getString("private_dns"))
        // Q0249: dvpnd needs the network itself, not only its kind, to see a reconnect.
        assertEquals("wifi", st.getString("underlying"))
        assertEquals("wifi#4242", st.getString("underlying_id"))
    }

    @Test fun unknownOpAndGarbageAreErrorsNotCrashes() {
        assertFalse(JSONObject(reply("""{"op":"format_disk"}""", FakeHost()).line).getBoolean("ok"))
        assertFalse(JSONObject(reply("not json", FakeHost()).line).getBoolean("ok"))
    }

    @Test fun cidrParsing() {
        assertNotNull(Cidr.parse("0.0.0.0/0"))
        assertNotNull(Cidr.parse("::/0"))
        assertNotNull(Cidr.parse("fdfe:dcba:9876::1/126"))
        assertNull(Cidr.parse("10.0.0.1/33"))
        assertNull(Cidr.parse("10.0.0.1"))
        assertNull(Cidr.parse("1::2::3/64"))
        assertTrue(Cidr.isIp("9.9.9.9"))
        assertFalse(Cidr.isIp("example.com"))
    }
}
