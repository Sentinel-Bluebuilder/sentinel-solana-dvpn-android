package network.sentinel.devnetdvpn.vpn

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import network.sentinel.devnetdvpn.node.NodeRuntime
import org.json.JSONObject

// ─── Test hooks (debug builds only, BuildConfig.TEST_HOOKS) ───
// adb can reach abstract sockets (`adb forward tcp:N localabstract:NAME`), not our private files.
//   ddv-dvpnd  byte relay to dvpnd's control socket (gRPC from a host-side CLI)
//   ddv-exec   one JSON line {"args":[...],"env":{...}} → {"code":N,"out":"..."}; dvpnd
//              subcommands, the app CLI (Node, `cli ...`) and the split setting only (no shell);
//              env keys limited to CLI_ENV
// Callers must be shell (adb, uid 2000) or this app.

class DebugHooks(private val daemon: DaemonProcess, private val node: NodeRuntime, private val ctx: Context) {
    private val servers = mutableListOf<LocalServerSocket>()
    @Volatile private var running = true

    fun start() {
        listen(RELAY) { relay(it) }
        listen(EXEC) { exec(it) }
    }

    fun stop() {
        running = false
        servers.forEach {
            try {
                it.close()
            } catch (e: IOException) {
                Log.w(TAG, "closing hook", e)
            }
        }
    }

    private fun listen(name: String, serve: (LocalSocket) -> Unit) {
        val server = LocalServerSocket(name)
        servers += server
        Thread({
            while (running) {
                val s = try {
                    server.accept()
                } catch (e: IOException) {
                    if (running) Log.w(TAG, "$name accept", e)
                    break
                }
                val uid = s.peerCredentials.uid
                if (uid != SHELL_UID && uid != Process.myUid()) {
                    Log.w(TAG, "$name refused uid $uid")
                    s.close()
                    continue
                }
                Thread({ s.use(serve) }, "ddv-hook-$name").start()
            }
        }, "ddv-hook-$name-accept").start()
    }

    private fun relay(client: LocalSocket) {
        val upstream = LocalSocket()
        try {
            upstream.connect(LocalSocketAddress(daemon.socket.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
        } catch (e: IOException) {
            Log.w(TAG, "dvpnd socket not reachable", e)
            return
        }
        upstream.use { up ->
            val t = Thread { pump(client.inputStream, up.outputStream) { up.shutdownOutput() } }
            t.start()
            pump(up.inputStream, client.outputStream) { client.shutdownOutput() }
            t.join()
        }
    }

    private fun pump(input: InputStream, output: OutputStream, done: () -> Unit) {
        val buf = ByteArray(32 * 1024)
        try {
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                output.write(buf, 0, n)
                output.flush()
            }
        } catch (e: IOException) {
            Log.d(TAG, "relay closed: ${e.message}")
        } finally {
            try {
                done()
            } catch (e: IOException) {
                Log.d(TAG, "relay shutdown: ${e.message}")
            }
        }
    }

    private fun exec(s: LocalSocket) {
        val reply = try {
            val req = JSONObject(s.inputStream.bufferedReader().readLine() ?: "{}")
            val args = req.optJSONArray("args")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            val env = req.optJSONObject("env")?.let { e -> e.keys().asSequence().filter { it in CLI_ENV }.associateWith { e.getString(it) } } ?: emptyMap()
            run(args, env)
        } catch (e: Exception) {
            JSONObject().put("code", 2).put("out", "hook error: ${e.message}")
        }
        // The caller may have hung up (its own timeout): that must never crash the app
        // (Test Lab Galaxy S24: uncaught "Broken pipe" here).
        try {
            s.outputStream.write((reply.toString() + "\n").toByteArray())
            s.outputStream.flush()
        } catch (e: IOException) {
            Log.w(TAG, "exec reply not delivered (caller gone): ${e.message}")
        }
    }

    private fun run(args: List<String>, env: Map<String, String> = emptyMap()): JSONObject {
        val cmd = args.firstOrNull() ?: return result(2, "usage: dvpnd <sub> ... | split <mode> [pkg...] | paths")
        return when (cmd) {
            "dvpnd" -> {
                val sub = args.getOrNull(1)
                if (sub !in DVPND_SUBS) return result(2, "dvpnd subcommand not allowed: $sub")
                val withHome = args.drop(1).toMutableList()
                // cb33: every instance command names c0 (no default instance) and the app's home.
                if ("--instance" !in withHome && sub != "version") withHome += listOf("--instance", DaemonProcess.INSTANCE)
                if ("--home" !in withHome && sub != "version") withHome += listOf("--home", daemon.home.absolutePath)
                val (code, out) = daemon.run(withHome)
                result(code, out)
            }
            "cli" -> {
                // A scratch data dir must stay inside this app's private files.
                env["DVPN_DATA_DIR"]?.let { d ->
                    if (!java.io.File(d).canonicalPath.startsWith(ctx.filesDir.canonicalPath + "/")) {
                        return result(2, "DVPN_DATA_DIR must be under ${ctx.filesDir}")
                    }
                }
                val (code, out) = node.cli(args.drop(1), env)
                result(code, out)
            }
            "split" -> {
                val mode = args.getOrNull(1) ?: return result(0, Split.load(ctx).toString())
                Split.save(ctx, Split.load(ctx).copy(mode = mode, packages = args.drop(2).toSet()))
                result(0, Split.load(ctx).toString())
            }
            "paths" -> result(0, JSONObject()
                .put("home", daemon.home.absolutePath)
                .put("socket", daemon.socket.absolutePath)
                .put("files", daemon.files.absolutePath).toString())
            "programs" -> result(0, JSONObject(daemon.linkPrograms() as Map<*, *>).toString())
            else -> result(2, "unknown hook command: $cmd")
        }
    }

    private fun result(code: Int, out: String) = JSONObject().put("code", code).put("out", out)

    private companion object {
        const val TAG = "ddv-hooks"
        const val RELAY = "ddv-dvpnd"
        const val EXEC = "ddv-exec"
        const val SHELL_UID = 2000
        val CLI_ENV = setOf("DVPN_KEYFILE", "DVPN_LOG_LEVEL", "DVPN_NODE_API_OVERRIDES", "DVPN_DATA_DIR", "DVPN_DAEMON_TARGET")
        // cb33 has no `status` subcommand; `key` lists the operator key.
        val DVPND_SUBS = setOf("init", "doctor", "version", "key")
    }
}
