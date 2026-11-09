package network.sentinel.devnetdvpn.node

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Process
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.io.IOException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import network.sentinel.devnetdvpn.vpn.Split
import org.json.JSONArray
import org.json.JSONObject

// ─── App bridge: what Node (the TS services + CLI) needs from Android ───
// Abstract local socket, name passed to Node as DVPN_APP_BRIDGE; only this app's UID may call.
// One JSON line per connection: {"op":"seal","data":"<b64>"} → {"ok":true,"data":"<b64>"}.
//   seal / unseal   AES-256-GCM with a key that lives in Android Keystore (never exported);
//                   sealed form = base64(iv 12 bytes ‖ ciphertext+tag)
//   info            SDK level, device, app version (for `version` / diagnostics)
//   daemonRestart   restart dvpnd after the app rewrote its config (`daemon set`, setup)
//   openUrl copy notify exportPath   what Electron did in the desktop app
//   splitGet splitSet apps           per-app split tunnelling (vpn/Split.kt), launchable apps
//   pickFile                         system document picker via MainActivity (FilePicker)

class AppBridge(private val ctx: Context, private val restartDaemon: () -> Unit) {
    val name = "ddv-app-" + ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val server = LocalServerSocket(name)
    @Volatile private var running = true

    fun start() {
        Thread({
            while (running) {
                val s = try {
                    server.accept()
                } catch (e: IOException) {
                    if (running) Log.w(TAG, "accept", e)
                    break
                }
                if (s.peerCredentials.uid != Process.myUid()) {
                    Log.w(TAG, "refused uid ${s.peerCredentials.uid}")
                    s.close()
                    continue
                }
                Thread({ s.use(::serve) }, "ddv-app-bridge").start()
            }
        }, "ddv-app-bridge-accept").start()
    }

    fun stop() {
        running = false
        try {
            server.close()
        } catch (e: IOException) {
            Log.w(TAG, "close", e)
        }
    }

    private fun serve(s: LocalSocket) {
        val reply = try {
            handle(JSONObject(s.inputStream.bufferedReader().readLine() ?: "{}"))
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
        }
        s.outputStream.write((reply.toString() + "\n").toByteArray())
        s.outputStream.flush()
    }

    fun handle(req: JSONObject): JSONObject = when (val op = req.optString("op")) {
        "seal" -> ok(seal(Base64.decode(req.getString("data"), Base64.NO_WRAP)))
        "unseal" -> ok(unseal(Base64.decode(req.getString("data"), Base64.NO_WRAP)))
        "info" -> JSONObject().put("ok", true)
            .put("sdk", android.os.Build.VERSION.SDK_INT)
            .put("device", android.os.Build.MODEL)
            .put("app", ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName)
        "openUrl" -> openUrl(req.getString("url"))
        "copy" -> copy(req.getString("text"))
        "notify" -> notify(req.optString("title"), req.optString("body"), req.optBoolean("silent"))
        "exportPath" -> exportPath(req.optString("name", "export.txt"))
        "daemonRestart" -> { restartDaemon(); done() }
        "splitGet" -> Split.load(ctx).let { s ->
            done().put("mode", s.mode).put("packages", JSONArray(s.packages.sorted()))
                .put("routeMode", s.routeMode).put("routes", JSONArray(s.routes.sorted()))
        }
        "splitRoutesSet" -> splitRoutesSet(req.getString("mode"), req.optJSONArray("routes"))
        "splitSet" -> splitSet(req.getString("mode"), req.optJSONArray("packages"))
        "apps" -> done().put("apps", launchableApps())
        // The VPN interface kept up with no session = the kill switch is blocking (the app's own
        // traffic is outside the VPN, so it can't see the block by trying the internet).
        "vpnState" -> done().put("state", network.sentinel.devnetdvpn.vpn.DvpnVpnService.running?.state()?.toJson())
        "pickFile" -> FilePicker.pick(ctx, req.optLong("timeoutMs", 290_000))?.let { done().put("path", it) }
            ?: JSONObject().put("ok", false).put("error", "cancelled")
        else -> JSONObject().put("ok", false).put("error", "unknown op $op")
    }

    private fun done() = JSONObject().put("ok", true)

    private fun splitSet(mode: String, list: JSONArray?): JSONObject {
        val pkgs = (0 until (list?.length() ?: 0)).map { list!!.getString(it) }.toSet() - ctx.packageName
        require(mode != Split.MODE_INCLUDE || pkgs.isNotEmpty()) { "'only these apps' needs at least one app" }
        Split.save(ctx, Split.load(ctx).copy(mode = mode, packages = if (mode == Split.MODE_ALL) emptySet() else pkgs))
        return done()
    }

    private fun splitRoutesSet(mode: String, list: JSONArray?): JSONObject {
        val routes = (0 until (list?.length() ?: 0)).map { list!!.getString(it) }.toSet()
        val cur = Split.load(ctx)
        Split.save(ctx, cur.copy(routeMode = mode, routes = if (mode == Split.MODE_ALL) emptySet() else routes))
        return done()
    }

    /** Apps with a launcher icon (what a person thinks of as "apps"), this one left out. */
    private fun launchableApps(): JSONArray {
        val pm = ctx.packageManager
        val main = android.content.Intent(android.content.Intent.ACTION_MAIN).addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        val out = JSONArray()
        pm.queryIntentActivities(main, 0).map { it.activityInfo.applicationInfo }.distinctBy { it.packageName }
            .filter { it.packageName != ctx.packageName }
            .forEach { ai ->
                val o = JSONObject().put("pkg", ai.packageName).put("label", pm.getApplicationLabel(ai).toString())
                    .put("system", (ai.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
                iconPng(pm.getApplicationIcon(ai))?.let { o.put("icon", it) }
                out.put(o)
            }
        return out
    }

    /** The app's own launcher icon as a small PNG (base64), drawn here so the page never loads files. */
    private fun iconPng(d: android.graphics.drawable.Drawable): String? = try {
        val px = 48
        val bmp = android.graphics.Bitmap.createBitmap(px, px, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        d.setBounds(0, 0, px, px)
        d.draw(c)
        val bytes = java.io.ByteArrayOutputStream().also { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bmp.recycle()
        Base64.encodeToString(bytes, Base64.NO_WRAP)
    } catch (e: RuntimeException) {
        Log.w(TAG, "app icon not drawn", e)
        null
    }

    private fun openUrl(url: String): JSONObject {
        val u = android.net.Uri.parse(url)
        require(u.scheme == "https") { "only https links open" }
        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, u).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        return done()
    }

    private fun copy(text: String): JSONObject {
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            val cm = ctx.getSystemService(android.content.ClipboardManager::class.java)
            cm.setPrimaryClip(android.content.ClipData.newPlainText("Devnet dVPN", text.take(4096)))
        }
        return done()
    }

    private fun notify(title: String, body: String, silent: Boolean): JSONObject {
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        val n = androidx.core.app.NotificationCompat.Builder(ctx, network.sentinel.devnetdvpn.DvpnApp.CHANNEL_EVENTS)
            .setSmallIcon(network.sentinel.devnetdvpn.R.drawable.ic_tile)
            .setContentTitle(title.ifEmpty { "Devnet dVPN" })
            .setContentText(body.take(500))
            .setSilent(silent)
            .setAutoCancel(true)
            .build()
        nm.notify(notifyId.incrementAndGet(), n)
        return done()
    }

    /** Exports (history CSV, test reports) go to files/exports; the UI shares them from there. */
    private fun exportPath(name: String): JSONObject {
        val safe = name.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "export.txt" }
        val dir = java.io.File(ctx.filesDir, "exports").apply { mkdirs() }
        return done().put("path", java.io.File(dir, safe).absolutePath)
    }

    private val notifyId = java.util.concurrent.atomic.AtomicInteger(100)

    private fun ok(bytes: ByteArray) = JSONObject().put("ok", true).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key())
        return c.iv + c.doFinal(plain)
    }

    private fun unseal(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_LEN) { "sealed data too short" }
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_LEN))
        return c.doFinal(sealed, IV_LEN, sealed.size - IV_LEN)
    }

    private companion object {
        const val TAG = "ddv-app-bridge"
        const val KEY_ALIAS = "test-host"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_LEN = 12
    }
}
