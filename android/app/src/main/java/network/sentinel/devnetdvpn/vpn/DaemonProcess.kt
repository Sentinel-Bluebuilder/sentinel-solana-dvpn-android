package network.sentinel.devnetdvpn.vpn

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit

// ─── dvpnd process ───
// dvpnd and the protocol programs ship as lib*.so in nativeLibraryDir (the only place an app may
// exec from). bin/ holds symlinks with the names dvpnd looks up on PATH. One
// `sentinel-dvpnd run --instance c0 --home <home>` runs while the VPN service lives; it is restarted
// with backoff if it dies.
//
// cb33 layout (src/core/daemon/layout.ts, Android row): the home is the app's own
// files/sentinel-dvpn/c0 (one config.toml, keys/operator.json, data.db, daemon.sock). The pre-cb33
// home files/dvpnd/client is moved into it once by the app's Node side (migrateAndroidHome).

/**
 * [onExit] runs when dvpnd exits on its own (crash, kill, config restart): the session it ran is
 * gone, so the VPN interface must not stay up as a dead end (the service releases it; a kill
 * switch hold stays, which is the point of the kill switch).
 */
class DaemonProcess(
    private val ctx: Context,
    private val platformSocket: () -> String?,
    private val onExit: () -> Unit = {},
) {
    val files: File = ctx.filesDir
    val home = File(files, "$PRODUCT_DIR/$INSTANCE")

    /** The pre-cb33 home (two config files, key "device"); read once by the migration. */
    val legacyHome = File(files, "dvpnd/client")
    val socket = File(home, "daemon.sock")
    private val bin = File(files, "bin")
    private val logFile = File(files, "logs/dvpnd.log")
    private val nativeDir = File(ctx.applicationInfo.nativeLibraryDir)

    @Volatile private var proc: Process? = null
    @Volatile private var wanted = false
    private var supervisor: Thread? = null

    val initialized: Boolean get() = File(home, "config.toml").exists()
    val running: Boolean get() = proc?.isAlive == true

    /** Creates bin/ links. Returns the programs found / missing (for `daemon drivers`). */
    fun linkPrograms(): Map<String, Boolean> {
        bin.mkdirs()
        // The pre-cb33 name: its link points into an old APK folder that is gone after an update.
        File(bin, "dvpnd").let { if (isSymlink(it)) it.delete() }
        return PROGRAMS.mapValues { (name, lib) ->
            val target = File(nativeDir, lib)
            val link = File(bin, name)
            if (link.exists() || isSymlink(link)) link.delete()
            if (!target.exists()) return@mapValues false
            try {
                Os.symlink(target.absolutePath, link.absolutePath)
                true
            } catch (e: ErrnoException) {
                Log.w(TAG, "linking $name", e)
                false
            }
        }
    }

    /** Runs a one-shot dvpnd subcommand (init, doctor, version) and returns exit code + output. */
    fun run(args: List<String>, timeoutSec: Long = 60): Pair<Int, String> {
        linkPrograms()
        val pb = ProcessBuilder(listOf(File(bin, DAEMON_NAME).absolutePath) + args)
            .redirectErrorStream(true)
        env(pb)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            return 124 to out + "\n(timed out after ${timeoutSec}s)"
        }
        return p.exitValue() to out
    }

    @Synchronized
    fun start() {
        if (wanted) return
        wanted = true
        // Before anything waits for the home: on a fresh install Node runs `sentinel-dvpnd init`
        // through bin/sentinel-dvpnd (DVPND_BIN), and that link must exist for it.
        linkPrograms()
        supervisor = Thread(::supervise, "ddv-dvpnd").also { it.start() }
    }

    @Synchronized
    fun stop() {
        wanted = false
        supervisor?.interrupt()
        proc?.let { p ->
            p.destroy() // SIGTERM: dvpnd stops the session and settles its state
            if (!p.waitFor(8, TimeUnit.SECONDS)) p.destroyForcibly()
        }
        proc = null
    }

    @Volatile private var quickRestart = false

    /** Restart dvpnd now (new config written by the app). The supervisor starts it again in ~1 s. */
    fun restart() {
        quickRestart = true
        proc?.destroy()
    }

    private fun supervise() {
        var backoffMs = 1_000L
        while (wanted) {
            if (!initialized) {
                Log.i(TAG, "dvpnd home not initialised yet; waiting")
                if (!sleep(3_000)) return
                continue
            }
            linkPrograms()
            logFile.parentFile?.mkdirs()
            if (logFile.length() > MAX_LOG) logFile.renameTo(File(logFile.path + ".1"))
            val pb = ProcessBuilder(listOf(File(bin, DAEMON_NAME).absolutePath) + runArgs(home.absolutePath))
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile))
            env(pb)
            val started = System.currentTimeMillis()
            val p = try {
                pb.start()
            } catch (e: java.io.IOException) {
                Log.e(TAG, "starting dvpnd", e)
                if (!sleep(backoffMs)) return
                continue
            }
            proc = p
            val code = try {
                p.waitFor()
            } catch (e: InterruptedException) {
                return
            }
            if (!wanted) return
            Log.w(TAG, "dvpnd exited with $code; restarting")
            try {
                onExit()
            } catch (e: RuntimeException) {
                Log.e(TAG, "releasing the VPN interface after dvpnd exited", e)
            }
            backoffMs = if (quickRestart || System.currentTimeMillis() - started > 60_000) 1_000 else (backoffMs * 2).coerceAtMost(30_000)
            quickRestart = false
            if (!sleep(backoffMs)) return
        }
    }

    private fun env(pb: ProcessBuilder) {
        val e = pb.environment()
        e.putAll(childEnv(e["PATH"]))
        e["HOME"] = files.absolutePath
        e["TMPDIR"] = ctx.cacheDir.absolutePath
    }

    /** What any dvpnd run needs (the daemon, and `dvpnd doctor` started from Node). */
    fun childEnv(basePath: String? = System.getenv("PATH")): Map<String, String> = buildMap {
        put("PATH", bin.absolutePath + ":" + (basePath ?: "/system/bin"))
        platformSocket()?.let { put("DVPND_PLATFORM_SOCKET", it) }
        // dvpnd serves quality probes here (exit IP / speed through the tunnel, D-A2); Node dials it.
        put("DVPND_PROBE_SOCKET", probeSocket)
        put("DVPN_PROBE_SOCKET", probeSocket)
    }

    /** Abstract socket name, random per service start (same-UID check on the dvpnd side too). */
    private val probeSocket = "ddv-probe-" + java.util.UUID.randomUUID().toString().replace("-", "").take(16)

    private fun sleep(ms: Long): Boolean = try {
        Thread.sleep(ms)
        true
    } catch (e: InterruptedException) {
        false
    }

    private fun isSymlink(f: File) = try {
        Os.lstat(f.absolutePath)
        true
    } catch (e: ErrnoException) {
        false
    }

    companion object {
        private const val TAG = "ddv-dvpnd"
        private const val MAX_LOG = 5L * 1024 * 1024

        /** cb33 names (layout.ts): binary, product folder, the app's one client instance. */
        const val DAEMON_NAME = "sentinel-dvpnd"
        const val PRODUCT_DIR = "sentinel-dvpn"
        const val INSTANCE = "c0"

        /** cb33 has no default instance: every run names it. */
        fun runArgs(home: String): List<String> = listOf("run", "--instance", INSTANCE, "--home", home)

        /** PATH name → file in nativeLibraryDir. */
        val PROGRAMS = linkedMapOf(
            DAEMON_NAME to "libdvpnd.so",
            "v2ray" to "libv2ray.so",
            "xray" to "libxray.so",
            "hysteria2" to "libhysteria2.so",
            "openvpn" to "libovpnexec.so",
        )
    }
}
