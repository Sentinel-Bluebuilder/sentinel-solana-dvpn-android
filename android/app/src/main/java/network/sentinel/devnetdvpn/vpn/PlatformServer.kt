package network.sentinel.devnetdvpn.vpn

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Process
import android.util.Log
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.security.SecureRandom

// ─── Platform socket ───
// Abstract unix socket that only our own UID may use (dvpnd runs as our UID). The name is
// random per service start and handed to dvpnd in DVPND_PLATFORM_SOCKET.

class PlatformServer(private val host: PlatformHost) {
    val name: String = "ddv-platform-" + randomToken()
    private val server = LocalServerSocket(name)
    private val thread = Thread(::loop, "ddv-platform")
    @Volatile private var running = true

    fun start() = thread.start()

    fun stop() {
        running = false
        try {
            server.close()
        } catch (e: IOException) {
            Log.w(TAG, "closing platform socket", e)
        }
    }

    private fun loop() {
        while (running) {
            val sock = try {
                server.accept()
            } catch (e: IOException) {
                if (running) Log.w(TAG, "accept failed", e)
                break
            }
            // One request per connection, served off the accept thread so a slow establish
            // (the VPN consent path) never blocks a status call.
            Thread({ serve(sock) }, "ddv-platform-conn").start()
        }
    }

    private fun serve(sock: LocalSocket) {
        sock.use { s ->
            try {
                if (s.peerCredentials.uid != Process.myUid()) {
                    Log.w(TAG, "refused platform call from uid ${s.peerCredentials.uid}")
                    return
                }
                val line = BufferedReader(InputStreamReader(s.inputStream)).readLine() ?: return
                val reply = PlatformProtocol.handle(line, host)
                if (reply.fd != null) s.setFileDescriptorsForSend(arrayOf(reply.fd))
                s.outputStream.write((reply.line + "\n").toByteArray())
                s.outputStream.flush()
                s.setFileDescriptorsForSend(null)
            } catch (e: IOException) {
                Log.w(TAG, "platform call failed", e)
            }
        }
    }

    private companion object {
        const val TAG = "ddv-platform"

        fun randomToken(): String {
            val b = ByteArray(8)
            SecureRandom().nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }
    }
}
