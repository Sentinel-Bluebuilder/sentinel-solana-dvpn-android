package network.sentinel.devnetdvpn

import android.annotation.SuppressLint
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import network.sentinel.devnetdvpn.node.NodeMain
import network.sentinel.devnetdvpn.vpn.DvpnVpnService
import org.json.JSONObject

// ─── Main screen: the Windows app's renderer in a WebView ───
// Asks for VPN consent once, starts the VPN service (dvpnd + the Node engine live there), then
// shows the renderer from APK assets at https://appassets.androidplatform.net/assets/renderer/.
// window.api is injected at document start (out/android/web-preload.js) and bridged here to
// NodeMain. No remote content: every other origin is refused.
class MainActivity : AppCompatActivity(), NodeMain.Listener {
    private lateinit var web: WebView
    private lateinit var root: android.widget.FrameLayout
    private val ui = Handler(Looper.getMainLooper())
    @Volatile private var engine: NodeMain? = null
    private var attachTries = 0

    /** "Open file" for Node (FilePicker): one pick at a time, completed by the picker's result. */
    @Volatile private var pendingPick: java.util.concurrent.CompletableFuture<android.net.Uri?>? = null
    private val openDocument = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri ->
        pendingPick?.complete(uri)
        pendingPick = null
    }
    private val pickerHost = network.sentinel.devnetdvpn.node.FilePicker.Host { done ->
        ui.post {
            pendingPick?.complete(null) // a newer request replaces an unanswered one
            pendingPick = done
            openDocument.launch(arrayOf("application/json", "text/plain", "application/octet-stream", "*/*"))
        }
    }
    /** Android 13+: notifications (connected, dropped, credit used up…) need the person's OK. */
    private val askNotifications = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { granted ->
        Log.i(TAG, "notifications ${if (granted) "allowed" else "declined"}")
    }

    /** Renderer calls made before the service had an engine (first seconds after launch). */
    private val early = mutableListOf<Triple<Long, String, String>>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Android 15 draws edge to edge: keep the page clear of the status bar, navigation bar,
        // cutout and keyboard by padding a container (WebView ignores its own padding).
        root = android.widget.FrameLayout(this)
        root.setBackgroundColor(if (isNight()) 0xFF0A0B0D.toInt() else 0xFFF6F7F9.toInt())
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })
        network.sentinel.devnetdvpn.node.FilePicker.clearCache(this)
        network.sentinel.devnetdvpn.node.FilePicker.host = pickerHost
        ensureService()
        buildWeb()
        attach()
    }

    /**
     * The page: a fresh WebView with the asset loader, the bridge and the preload, loaded and put in
     * `root`. Also the recovery after the WebView renderer dies (Q0317): without it the renderer's
     * death kills this whole process, and with it the Node engine and dvpnd, mid-transaction.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWeb() {
        web = WebView(this)
        root.addView(web)
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == HOST) return false
                if (url.scheme == "https") startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            // Q0317: the system may kill the renderer (sandboxed process) at any time. Returning
            // false lets the WebView take this process down with it: a Top up or Sign in flight
            // then never reaches the chain. Drop the dead view and load the page again; the
            // engine keeps running, so a call already sent still finishes.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "WebView renderer gone (crashed=${detail.didCrash()}); rebuilding the page")
                if (view !== web) return true // an older view, already replaced
                root.removeView(view)
                view.destroy()
                buildWeb()
                return true
            }
        }
        if (BuildConfig.TEST_HOOKS) WebView.setWebContentsDebuggingEnabled(true)
        web.addJavascriptInterface(Native(), "DdvNative")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, preloadScript(), setOf("https://$HOST"))
        } else {
            Log.e(TAG, "WebView too old for document-start scripts")
        }
        web.loadUrl("https://$HOST/assets/node/renderer/index.html")
    }

    private fun isNight(): Boolean =
        (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    private fun preloadScript(): String =
        assets.open("node/web-preload.js").bufferedReader().use { it.readText() }

    /** Waits for the service's engine, then listens to it. */
    private fun attach() {
        val m = DvpnVpnService.running?.main
        if (m == null) {
            if (attachTries++ < 120) ui.postDelayed(::attach, 250) else Log.e(TAG, "engine never came up")
            return
        }
        m.addListener(this)
        synchronized(early) {
            engine = m
            early.forEach { (id, ch, p) -> m.invoke(id, ch, p) }
            early.clear()
        }
    }

    override fun onDestroy() {
        if (network.sentinel.devnetdvpn.node.FilePicker.host === pickerHost) network.sentinel.devnetdvpn.node.FilePicker.host = null
        pendingPick?.complete(null)
        engine?.removeListener(this)
        web.destroy()
        super.onDestroy()
    }

    override fun onReply(id: Long, resultJson: String) = js("window.__ddv&&window.__ddv.reply($id, ${JSONObject.quote(resultJson)})")

    override fun onEvent(channel: String, payloadJson: String) =
        js("window.__ddv&&window.__ddv.event(${JSONObject.quote(channel)}, ${JSONObject.quote(payloadJson)})")

    private fun js(code: String) { ui.post { web.evaluateJavascript(code, null) } }

    private inner class Native {
        @JavascriptInterface
        fun invoke(id: Long, channel: String, payloadJson: String) { // Long: ids start at the page load time in µs (Q0317)
            val m = synchronized(early) {
                engine ?: run {
                    early.add(Triple(id, channel, payloadJson))
                    null
                }
            } ?: return
            m.invoke(id, channel, payloadJson)
        }

        @JavascriptInterface
        fun visible(shown: Boolean) { engine?.visible(shown) }

        /** Always-on VPN and "Block connections without VPN" live in the system VPN settings. */
        @JavascriptInterface
        fun openVpnSettings() {
            ui.post { startActivity(Intent(android.provider.Settings.ACTION_VPN_SETTINGS)) }
        }

        /** Keeps the window out of screenshots, screen recording and the Recents thumbnail (the recovery phrase card). */
        @JavascriptInterface
        fun setSecure(on: Boolean) {
            ui.post {
                if (on) window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
                else window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
            }
        }

        @JavascriptInterface
        fun welcomed(): Boolean = MainActivity.welcomed

        @JavascriptInterface
        fun markWelcomed() { MainActivity.welcomed = true }

        /** Read-only: the system's Always-on VPN / "Block connections without VPN" for this app ("{}" when the service is not up). */
        @JavascriptInterface
        fun vpnSystemState(): String {
            val s = network.sentinel.devnetdvpn.vpn.DvpnVpnService.running?.state() ?: return "{}"
            return org.json.JSONObject().put("alwaysOn", s.alwaysOn).put("lockdown", s.lockdown).toString()
        }

        /** False when the person turned this app's notifications off (or declined the prompt). */
        @JavascriptInterface
        fun notificationsAllowed(): Boolean = androidx.core.app.NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled()

        @JavascriptInterface
        fun openNotificationSettings() {
            ui.post {
                startActivity(
                    Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName),
                )
            }
        }
    }

    private fun ensureService() {
        val consent = VpnService.prepare(this)
        if (consent != null) {
            @Suppress("DEPRECATION")
            startActivityForResult(consent, REQ_VPN)
        } else {
            DvpnVpnService.start(this)
            askNotificationsOnce()
        }
    }

    @Deprecated("Activity result API is not needed for one request")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_VPN && resultCode == RESULT_OK) DvpnVpnService.start(this)
        if (requestCode == REQ_VPN) askNotificationsOnce()
    }

    /** One prompt, after the VPN consent; a "no" is respected (Settings shows how to turn them on). */
    private fun askNotificationsOnce() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val perm = android.Manifest.permission.POST_NOTIFICATIONS
        if (checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("ui", MODE_PRIVATE)
        if (prefs.getBoolean("askedNotifications", false)) return
        prefs.edit().putBoolean("askedNotifications", true).apply()
        askNotifications.launch(perm)
    }

    private companion object {
        /** F2.1 "welcome first on every launch": a launch = this app process starting, not the screen being rebuilt. */
        @Volatile var welcomed = false
        const val TAG = "ddv-main"
        const val HOST = "appassets.androidplatform.net"
        const val REQ_VPN = 1
    }
}
