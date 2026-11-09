package network.sentinel.devnetdvpn.node

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit
import network.sentinel.devnetdvpn.BuildConfig
import network.sentinel.devnetdvpn.vpn.DaemonProcess

// ─── Node runtime (the Windows app's TypeScript services + CLI) ───
// Node 22 is shipped as an executable (libnode-bin.so in nativeLibraryDir, built by
// scripts/build-node-android.sh). The JS bundles and daemon.proto ship as APK assets under
// node/ and are copied to files/node once per app version. Node runs as this app's UID, so it
// reaches dvpnd's unix socket directly and its traffic stays outside the VPN (D-A2).

class NodeRuntime(private val ctx: Context, private val daemon: DaemonProcess, private val bridgeName: String) {
    val root = File(ctx.filesDir, "node")
    val resources = File(root, "resources")
    val dataDir = File(ctx.filesDir, "data")
    val nodeBin = File(ctx.applicationInfo.nativeLibraryDir, "libnode-bin.so")

    val cliBundle get() = File(root, "cli.cjs")
    val mainBundle get() = File(root, "main.cjs")
    val webPreload get() = File(root, "web-preload.js")

    /** Copies the assets when this app version has not been extracted yet. */
    @Synchronized
    fun prepare() {
        val stamp = File(root, ".version")
        val want = "${BuildConfig.VERSION_CODE}-${BuildConfig.VERSION_NAME}-${apkTime()}"
        if (stamp.isFile && stamp.readText() == want) return
        root.mkdirs()
        copyAssets("node", root)
        dataDir.mkdirs()
        stamp.writeText(want)
        Log.i(TAG, "node assets extracted ($want)")
    }

    private fun apkTime(): Long = File(ctx.applicationInfo.sourceDir).lastModified()

    private fun copyAssets(path: String, dest: File) {
        val names = ctx.assets.list(path) ?: emptyArray()
        if (names.isEmpty()) {
            dest.parentFile?.mkdirs()
            ctx.assets.open(path).use { input -> dest.outputStream().use { input.copyTo(it) } }
            return
        }
        dest.mkdirs()
        names.forEach { copyAssets("$path/$it", File(dest, it)) }
    }

    /** Environment shared by every Node process this app runs. */
    fun env(): Map<String, String> = daemon.childEnv() + mapOf(
        "HOME" to ctx.filesDir.absolutePath,
        "TMPDIR" to ctx.cacheDir.absolutePath,
        "LD_LIBRARY_PATH" to ctx.applicationInfo.nativeLibraryDir, // libc++_shared.so for node
        "DVPN_DATA_DIR" to dataDir.absolutePath,
        "DVPN_RESOURCES" to resources.absolutePath,
        "DVPN_DAEMON_TARGET" to "unix://" + daemon.socket.absolutePath,
        "DVPN_DAEMON_HOME" to daemon.home.absolutePath,
        "DVPND_BIN" to File(daemon.files, "bin/" + DaemonProcess.DAEMON_NAME).absolutePath,
        "DVPN_DAEMON_LEGACY_HOME" to daemon.legacyHome.absolutePath,
        "DVPN_NO_BRIDGE" to "1",
        "DVPN_PLATFORM" to "android",
        "DVPN_APP_BRIDGE" to bridgeName,
        "DVPN_NODE_ROOT" to root.absolutePath,
        "DVPN_APP_VERSION" to BuildConfig.VERSION_NAME,
        "NODE_OPTIONS" to "--max-old-space-size=256",
    )

    /** Runs the CLI once and returns (exit code, combined output). */
    fun cli(args: List<String>, extraEnv: Map<String, String> = emptyMap(), timeoutSec: Long = 600): Pair<Int, String> {
        prepare()
        val pb = ProcessBuilder(listOf(nodeBin.absolutePath, cliBundle.absolutePath) + args)
            .directory(ctx.filesDir)
            .redirectErrorStream(true)
        pb.environment().putAll(env() + extraEnv)
        val p = pb.start()
        val out = StringBuilder()
        val reader = Thread { p.inputStream.bufferedReader().forEachLine { out.appendLine(it) } }
        reader.start()
        if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            reader.join(2000)
            return 124 to out.append("cli timed out after ${timeoutSec}s\n").toString()
        }
        reader.join(5000)
        return p.exitValue() to out.toString()
    }

    private companion object {
        const val TAG = "test-host"
    }
}
