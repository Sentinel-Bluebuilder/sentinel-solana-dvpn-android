package network.sentinel.devnetdvpn

import android.content.Intent
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// ─── Real-device gate (A8): Firebase Test Lab, arm64 phones ───
// What the emulator cannot prove: the arm64 binaries (Node, dvpnd, protocol programs) run on real
// hardware and a real network path. The test does what a person does on a fresh install (system
// VPN consent, notification prompt), then drives the app's own CLI through the debug exec hook
// (same UID as the app): engine up, device set up from a throwaway devnet wallet, one paid
// session per protocol with the exit IP checked through the tunnel, disconnect.
//
// Arguments (instrumentation, `--environment-variables` on Test Lab):
//   ftlKey        base64 of the throwaway wallet key file (JSON array of 64 numbers) — required
//   ftlProtocols  comma list, default wireguard,amneziawg,openvpn,v2ray,xray,hysteria2
// Report: <external files>/ftl-report.txt (pull /sdcard/Android/data/<pkg>/files).
@RunWith(AndroidJUnit4::class)
class RealDeviceTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(inst)
    private val ctx = inst.targetContext
    private val args = InstrumentationRegistry.getArguments()
    private val report = StringBuilder()
    private val failures = mutableListOf<String>()

    @Test
    fun freshPhoneEndToEnd() {
        try {
            run()
        } finally {
            // App-private logs (dvpnd, Node) next to the report, so Test Lab pulls them too.
            val logs = File(ctx.getExternalFilesDir(null), "logs").apply { mkdirs() }
            File(ctx.filesDir, "logs").listFiles()?.forEach { f ->
                try {
                    f.copyTo(File(logs, f.name), overwrite = true)
                } catch (e: IOException) {
                    Log.w(TAG, "copying ${f.name}", e)
                }
            }
            val out = File(ctx.getExternalFilesDir(null), "ftl-report.txt")
            out.writeText(report.toString())
            Log.i(TAG, "report at ${out.absolutePath}\n$report")
        }
        assertTrue("failed: ${failures.joinToString("; ")}", failures.isEmpty())
    }

    private fun run() {
        note("device ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}, SDK ${android.os.Build.VERSION.SDK_INT}, ABI ${android.os.Build.SUPPORTED_ABIS.joinToString()}")
        launchAndConsent()
        check("exec hook answers (VPN service + engine up)", waitForHook())
        val ver = cli("version")
        check("version runs in the phone's Node", ver.first == 0 && ver.second.contains("devnet"), ver.second)
        val drivers = cli("daemon drivers")
        check("protocol programs present", drivers.first == 0, drivers.second)

        val key = args.getString("ftlKey") ?: run {
            check("ftlKey argument given", false)
            return
        }
        val keyFile = File(ctx.filesDir, "test/owner.json").apply { parentFile?.mkdirs() }
        keyFile.writeText(String(Base64.decode(key, Base64.DEFAULT)))
        keyFile.setReadable(false, false)
        keyFile.setReadable(true, true)
        val env = mapOf("DVPN_KEYFILE" to keyFile.absolutePath)

        val rpc = cli("rpc state", env)
        note("rpc state:\n    ${rpc.second.trim().replace("\n", "\n    ")}")

        val init = cli("daemon init", env)
        check("daemon init (device key on this phone)", init.first == 0, init.second)
        val setup = cli("device setup --allowance 2 --yes", env, timeoutSec = 300)
        check("device setup (on-chain permission + fee SOL)", setup.first == 0, setup.second)
        Thread.sleep(8_000) // dvpnd restarts with the new config
        val doctor = cli("daemon doctor", env)
        check("daemon doctor has no FAIL row", doctor.first == 0 && !Regex("(?m)^FAIL").containsMatchIn(doctor.second), doctor.second)

        // ftl-run.sh passes the test node set (scripts/e2e/android/nodes.sh); the defaults are test-host.
        val nodeIp = args.getString("ftlNodeIp") ?: NODE_IP
        val protocols = args.getString("ftlNodes")?.split(',')?.mapNotNull { pair ->
            pair.split(':', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() }
        }?.toMap() ?: PROTOCOLS
        val wanted = (args.getString("ftlProtocols") ?: protocols.keys.joinToString(",")).split(',').map { it.trim() }
        for (name in wanted) {
            val node = protocols[name] ?: continue
            Thread.sleep(7_000)
            var c = cli("connect $node --units 1 --yes", env, timeoutSec = 240)
            if (c.first != 0 && (c.second.contains("rate-limiting") || c.second.contains("didn't answer in time"))) {
                // Public devnet RPC, shared Test Lab network: do what the message tells a person
                // (Retry). A timed-out RPC is benched for 60 s, so wait that out first.
                note("$name: public RPC slow or rate-limited; waiting a minute and trying again, as the app says")
                cli("disconnect", env)
                Thread.sleep(60_000)
                c = cli("connect $node --units 1 --yes", env, timeoutSec = 240)
            }
            if (!check("$name: connect", c.first == 0 && c.second.contains("onnected"), c.second)) {
                cli("disconnect", env)
                continue
            }
            Thread.sleep(3_000)
            val ip = cli("quality ip", env)
            check("$name: exit IP through the tunnel = node $nodeIp", ip.second.contains(nodeIp), ip.second)
            val speed = cli("quality speed", env, timeoutSec = 120)
            note("$name speed: ${speed.second.lines().firstOrNull { it.contains("Mb") } ?: speed.second.take(120)}")
            // Hold past the node's next usage report: the speed test's bytes must be counted on
            // our side too, or the session ends as "node overcharging" (Hysteria2, fixed in dvpnd).
            Thread.sleep(20_000)
            val st = cli("status", env)
            check("$name: still Protected 20 s after the speed test", st.second.contains("Protected"), st.second)
            Thread.sleep(7_000)
            val d = cli("disconnect", env)
            check("$name: disconnect", d.first == 0, d.second)
            Thread.sleep(3_000)
            val after = cli("quality ip", env)
            check("$name: exit IP back to direct", after.first == 0 && !after.second.contains(nodeIp), after.second)
        }
        if (args.getString("ftlKsPersist") != "false") protocols["wireguard"]?.let { ksPersist(it, env) }
        moneyRow(env)
        val ch = cli("channels", env)
        note("channels after the run:\n${ch.second}")
    }

    // ─── kill switch On (= persist): dvpnd dies with the tunnel up; the phone must stay blocked ───
    // The check runs as the shell uid (inside the VPN like any app). This test runs as the app's own uid,
    // which is outside the VPN by design, so its own traffic would say nothing.
    private fun ksPersist(node: String, env: Map<String, String>) {
        val set = cli("daemon set --kill-switch persist --yes", env, timeoutSec = 90)
        if (!check("KS: set On (persist)", set.first == 0, set.second)) return
        Thread.sleep(8_000)
        Thread.sleep(7_000)
        val c = cli("connect $node --units 1 --yes", env, timeoutSec = 240)
        if (check("KS: connect with the kill switch On", c.first == 0 && c.second.contains("onnected"), c.second)) {
            Thread.sleep(3_000)
            check("KS: internet works through the tunnel", shellPing())
            val pid = dvpndPid()
            if (check("KS: dvpnd process found", pid != null)) {
                android.os.Process.sendSignal(pid!!, 9)
                note("KS: killed dvpnd pid $pid (the app's supervisor restarts it)")
                var leaks = 0
                repeat(10) { if (shellPing()) leaks++; Thread.sleep(1_000) }
                check("KS: no direct internet in the 10 s after dvpnd died ($leaks of 10 pings answered)", leaks == 0)
                Thread.sleep(15_000)
                check("KS: still blocked after dvpnd is back", !shellPing())
            }
        }
        val r = cli("daemon restore-network", env, timeoutSec = 60)
        check("KS: Restore network", r.first == 0, r.second)
        cli("disconnect", env)
        Thread.sleep(3_000)
        check("KS: internet back after Restore network", shellPing())
        val off = cli("daemon set --kill-switch off --yes", env, timeoutSec = 90)
        check("KS: set Off again", off.first == 0, off.second)
        Thread.sleep(8_000)
    }

    // ─── money: what the sessions spent fits in what was signed and deposited; then settle ───
    private fun moneyRow(env: Map<String, String>) {
        val s = cli("sessions --json", env)
        val c = cli("channels --json", env)
        try {
            val sessions = JSONArray(s.second.trim().lines().last())
            val channels = JSONArray(c.second.trim().lines().last())
            for (i in 0 until channels.length()) {
                val ch = channels.getJSONObject(i)
                val addr = ch.optString("address")
                var spent = 0L
                for (k in 0 until sessions.length()) {
                    val x = sessions.getJSONObject(k)
                    if (x.optString("channel") == addr) spent += x.optString("spent", "0").toLongOrNull() ?: 0L
                }
                val cum = ch.optString("cumulative", "0").toLongOrNull() ?: -1L
                val escrow = ch.optString("escrow", "0").toLongOrNull() ?: -1L
                check("money $addr: spent $spent <= signed $cum <= deposit $escrow", spent <= cum && cum <= escrow)
            }
        } catch (e: org.json.JSONException) {
            check("money: sessions/channels read as JSON", false, "${e.message}\n${s.second.take(300)}\n${c.second.take(300)}")
        }
        Thread.sleep(7_000)
        val st = cli("settle run --yes", env, timeoutSec = 300)
        check("money: settle run (close the deposits)", st.first == 0, st.second)
    }

    private fun shellPing(): Boolean {
        val pfd = inst.uiAutomation.executeShellCommand("ping -c 1 -W 2 1.1.1.1")
        val out = android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).bufferedReader().readText()
        return out.contains("1 received") || out.contains("bytes from")
    }

    private fun dvpndPid(): Int? = File("/proc").listFiles()?.firstNotNullOfOrNull { p ->
        p.name.toIntOrNull()?.takeIf {
            try {
                File(p, "comm").readText().trim() == DAEMON
            } catch (e: IOException) {
                false
            }
        }
    }

    // ─── system dialogs, as a person taps them ───
    private fun launchAndConsent() {
        ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val ok = device.wait(Until.findObject(By.res("android", "button1")), 20_000)
        if (ok != null) {
            ok.click()
            note("VPN consent dialog shown and accepted")
        } else {
            // Some builds name the button differently; consent is still needed for the run.
            note("VPN consent dialog not found; granting through appops")
            shell("appops set ${ctx.packageName} ACTIVATE_VPN allow")
            ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        val granted = ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (android.os.Build.VERSION.SDK_INT >= 33 && granted) {
            // Test Lab grants every runtime permission at install, so no prompt appears there.
            // The prompt itself is checked on the emulator (feature-check.sh notify, F21).
            note("notification permission already granted at install (Test Lab); prompt not shown")
        } else if (android.os.Build.VERSION.SDK_INT >= 33) {
            val allow = device.wait(Until.findObject(By.res("com.android.permissioncontroller", "permission_allow_button")), 15_000)
            check("notification prompt shown once after VPN consent", allow != null)
            allow?.click()
        }
    }

    private fun shell(cmd: String) {
        inst.uiAutomation.executeShellCommand(cmd).close()
    }

    // ─── the debug exec hook (DebugHooks.EXEC), same protocol as scripts/e2e/android/hook.py ───
    private fun waitForHook(): Boolean {
        repeat(90) {
            if (cli("version").first == 0) return true
            Thread.sleep(1_000)
        }
        return false
    }

    private fun cli(line: String, env: Map<String, String> = emptyMap(), timeoutSec: Int = 120): Pair<Int, String> =
        exec(listOf("cli") + line.split(' '), env, timeoutSec)

    private fun exec(argv: List<String>, env: Map<String, String>, timeoutSec: Int): Pair<Int, String> = try {
        LocalSocket().use { s ->
            s.connect(LocalSocketAddress("ddv-exec", LocalSocketAddress.Namespace.ABSTRACT))
            s.soTimeout = timeoutSec * 1000
            val req = JSONObject().put("args", JSONArray(argv)).put("env", JSONObject(env))
            s.outputStream.write((req.toString() + "\n").toByteArray())
            s.outputStream.flush()
            val reply = s.inputStream.bufferedReader().readLine() ?: return 3 to "no reply"
            val j = JSONObject(reply)
            j.optInt("code", 1) to j.optString("out")
        }
    } catch (e: IOException) {
        Log.w(TAG, "exec ${argv.joinToString(" ")}", e)
        3 to "hook: ${e.message}"
    }

    private fun check(what: String, ok: Boolean, detail: String = ""): Boolean {
        note("${if (ok) "PASS" else "FAIL"} $what${if (!ok && detail.isNotBlank()) "\n    ${detail.take(600).replace("\n", "\n    ")}" else ""}")
        if (!ok) failures += what
        return ok
    }

    private fun note(s: String) {
        Log.i(TAG, s)
        report.append(s).append('\n')
    }

    private companion object {
        const val TAG = "ddv-ftl"
        const val DAEMON = "sentinel-dvpnd"
        // test-host (cb33), one listed entry per protocol; ftl-run.sh passes the set from nodes.sh.
        const val NODE_IP = "203.0.113.1"
        val PROTOCOLS = linkedMapOf(
            "wireguard" to "SLVJNn38s5RfqcVW7a7A4hGKqjY7Y1bKkUpG7wrGX5D",
            "amneziawg" to "1PwMkSjnyugAZHdHvDsddETzPUAubPkeyWymT7Ercn6",
            "openvpn" to "9EQJ7dBwneFUse9yy8Hg56u2wPiGF5qkjAaA1ZAr64nP",
            "v2ray" to "Di5V9K2Vt5uptJUk7oVVnkDRXt9qWy5HhLbkEJMxEuM2",
            "xray" to "E9RG1iZJjsLfEuLfDYTHM4yXCjyFE21jBbJLFvGoL2FD",
            "hysteria2" to "E8nefMLBuBzG1CrA4dSDU9mqq6ZNpv69Bt3w9QEtzvPf",
        )
    }
}
