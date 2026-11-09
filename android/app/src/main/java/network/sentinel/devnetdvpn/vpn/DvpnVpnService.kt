package network.sentinel.devnetdvpn.vpn

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.IpPrefix
import android.net.NetworkCapabilities
import android.net.ProxyInfo
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.util.Log
import java.io.FileDescriptor
import java.io.IOException
import java.net.Inet6Address
import java.net.InetAddress
import network.sentinel.devnetdvpn.BuildConfig
import network.sentinel.devnetdvpn.node.AppBridge
import network.sentinel.devnetdvpn.node.NodeMain
import network.sentinel.devnetdvpn.node.NodeRuntime
import network.sentinel.devnetdvpn.DvpnApp
import network.sentinel.devnetdvpn.MainActivity
import network.sentinel.devnetdvpn.R

// ─── VPN service ───
// Lives while the app is "on": owns the platform socket, the dvpnd process and the VPN interface.
// dvpnd decides when a tunnel exists; this service only builds / holds / drops the interface.

class DvpnVpnService : VpnService(), PlatformHost {
    private var platform: PlatformServer? = null
    private var daemon: DaemonProcess? = null
    private var hooks: DebugHooks? = null
    private var bridge: AppBridge? = null
    var node: NodeRuntime? = null
        private set
    /** The UI engine (renderer calls); the screen attaches to it while open. */
    var main: NodeMain? = null
        private set
    private val lock = Any()
    private var current: ParcelFileDescriptor? = null
    /** What [current] was built from (spec without its session name + split settings). */
    private var currentKey: Triple<TunnelSpec, Split, List<String>>? = null
    private var session: String? = null
    private var held = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopAsked = true
                shutdown()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> { stopAsked = false; startUp() } // ACTION_START, always-on ("android.net.VpnService"), restart
        }
        return START_STICKY
    }

    private var stopAsked = false

    private fun startUp(attempt: Int = 0) {
        // A systemExempted foreground service needs the VPN consent (android:activate_vpn) at this
        // moment. It can be gone although the caller checked it (revoked, or another VPN app took
        // over): Android then throws and the whole app crashed (Test Lab Pixel 8a, Android 15).
        // Stop instead; the screen asks for the VPN permission again when it opens.
        // Right after the consent dialog the permission can land a moment after this start (Test
        // Lab Pixel 8a: accepted at .368, refused at .411, then no service at all): retry for 3 s
        // (Android allows ~10 s from the start request to startForeground) before giving up.
        try {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
        } catch (e: SecurityException) {
            if (attempt < 15 && !stopAsked) {
                Handler(Looper.getMainLooper()).postDelayed({ if (!stopAsked) startUp(attempt + 1) }, 200)
                return
            }
            Log.w(TAG, "no VPN consent at service start; stopping: ${e.message}")
            stopSelf()
            return
        }
        if (platform == null) platform = PlatformServer(this).also { it.start() }
        val d = daemon ?: DaemonProcess(this, { platform?.name }, { release() }).also { daemon = it }
        d.start()
        val b = bridge ?: AppBridge(this) { d.restart() }.also { it.start(); bridge = it }
        val n = node ?: NodeRuntime(this, d, b.name).also { node = it }
        if (main == null) main = NodeMain(n).also { it.start() }
        if (BuildConfig.TEST_HOOKS && hooks == null) hooks = DebugHooks(d, n, this).also { it.start() }
        running = this
    }

    private fun shutdown() {
        daemon?.stop()
        hooks?.stop()
        hooks = null
        main?.stop()
        main = null
        bridge?.stop()
        bridge = null
        node = null
        platform?.stop()
        platform = null
        synchronized(lock) {
            held = false
            closeCurrent()
        }
        running = null
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    /** The user turned the VPN off in Settings, or another VPN took over. */
    override fun onRevoke() {
        Log.w(TAG, "VPN permission revoked")
        synchronized(lock) {
            held = false
            closeCurrent()
        }
        super.onRevoke()
    }

    // ─── PlatformHost ───

    override fun establish(spec: TunnelSpec): FileDescriptor {
        val split = Split.load(this)
        // Q0343: allow_lan also leaves the LAN's on-link IPv6 prefixes out of the tunnel. Part of the
        // re-use key: after a Wi-Fi/mobile handover the held interface is rebuilt for the new LAN.
        val onLinkV6 = if (spec.allowLan) onLinkIpv6Prefixes() else emptyList()
        val key = Triple(spec.copy(session = ""), split, onLinkV6)
        // A9: a switch with the kill switch holding the interface, to a tunnel with the very same
        // interface (V2Ray, Xray and Hysteria2 all use 172.19.0.1/30, same routes and DNS), re-uses
        // the held interface. A new establish() makes Android drop the old interface from the VPN
        // network and add the new one's routes ~0.1 s later: a window with no default route, so
        // traffic went direct. Only when the old session is released (nothing reads the interface)
        // and nothing about it would change; any other switch still builds a new interface.
        val reused = synchronized(lock) {
            current?.takeIf { held && session == null && key == currentKey }?.also {
                session = spec.session
                Log.i(TAG, "establish ${spec.session}: same interface as the held one, re-used (no handover)")
            }
        }
        if (reused != null) {
            updateNotification()
            return reused.fileDescriptor
        }
        val b = Builder().setSession(spec.session).setMtu(spec.mtu)
        spec.addrs.forEach { a -> Cidr.parse(a)!!.let { b.addAddress(it.addr, it.bits) } }
        val native = Build.VERSION.SDK_INT >= 33
        val plan = RouteSplit.plan(split.routeMode, split.routes, spec.routes, spec.dns, native, spec.allowLan, onLinkV6)
        if (onLinkV6.isNotEmpty()) Log.i(TAG, "allow LAN: on-link IPv6 kept out of the tunnel: $onLinkV6")
        plan.routes.forEach { r -> Cidr.parse(r)!!.let { b.addRoute(it.addr, it.bits) } }
        if (native) {
            (spec.excludeRoutes + plan.excludes).forEach { r ->
                Cidr.parse(r)!!.let { b.excludeRoute(IpPrefix(InetAddress.getByName(it.addr), it.bits)) }
            }
        }
        spec.dns.forEach { b.addDnsServer(it) }
        spec.httpProxy?.let { hp ->
            val (h, p) = hp.substringBeforeLast(":") to hp.substringAfterLast(":").toInt()
            b.setHttpProxy(ProxyInfo.buildDirectProxy(h, p))
        }
        split.apply(b, packageName)
        b.setConfigureIntent(openAppIntent())

        val pfd = b.establish() ?: throw IllegalStateException("VPN permission is not granted")
        synchronized(lock) {
            val old = current
            current = pfd
            currentKey = key
            session = spec.session
            old?.let { closeQuietly(it) } // new interface is up first, so nothing leaks between
            Log.i(TAG, "establish ${spec.session}: new interface up, replaced=${old != null} held=$held")
        }
        updateNotification()
        return pfd.fileDescriptor
    }

    override fun hold(hold: Boolean) {
        synchronized(lock) {
            held = hold
            if (!hold && session == null) closeCurrent()
            Log.i(TAG, "hold=$hold session=$session interface=${current != null}")
        }
        updateNotification()
    }

    override fun release() {
        synchronized(lock) {
            session = null
            if (!held) closeCurrent() // held: keep the interface so traffic stays blocked
            Log.i(TAG, "release: held=$held interface=${current != null}")
        }
        updateNotification()
    }

    override fun state(): PlatformState = synchronized(lock) {
        PlatformState(
            connected = session != null && current != null,
            held = held,
            alwaysOn = isAlwaysOn,
            lockdown = isLockdownEnabled,
            privateDns = Settings.Global.getString(contentResolver, "private_dns_mode") ?: "unknown",
            sdk = Build.VERSION.SDK_INT,
            splitMode = Split.load(this).mode,
            underlying = underlyingNetwork(),
            underlyingId = underlyingNetworkId(),
        )
    }

    // ─── helpers ───

    private fun closeCurrent() {
        current?.let { closeQuietly(it) }
        current = null
        currentKey = null
        session = null
    }

    private fun closeQuietly(p: ParcelFileDescriptor) {
        try {
            p.close()
        } catch (e: IOException) {
            Log.w(TAG, "closing vpn interface", e)
        }
    }

    /**
     * The on-link IPv6 prefixes of the network this phone is on (routes with no gateway on the active
     * non-VPN network, plus the prefixes of its global addresses), e.g. a home LAN's SLAAC /64 (Q0343).
     * RouteSplit drops anything that is not a sane IPv6 prefix.
     */
    private fun onLinkIpv6Prefixes(): List<String> {
        val cm = getSystemService(ConnectivityManager::class.java)
        val n = cm.activeNetwork?.takeIf { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == false }
            ?: cm.allNetworks.firstOrNull { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == false }
            ?: return emptyList()
        val lp = cm.getLinkProperties(n) ?: return emptyList()
        val fromRoutes = lp.routes.filter { r -> !r.hasGateway() && !r.isDefaultRoute && r.destination.address is Inet6Address }
            .map { r -> "${r.destination.address.hostAddress!!.substringBefore('%')}/${r.destination.prefixLength}" }
        val fromAddrs = lp.linkAddresses.filter { a -> a.address is Inet6Address && !a.address.isLinkLocalAddress }
            .map { a -> "${a.address.hostAddress!!.substringBefore('%')}/${a.prefixLength}" }
        val all = fromRoutes + fromAddrs
        val bad = all.filter { Cidr.parse(it) == null }
        if (bad.isNotEmpty()) Log.w(TAG, "allow LAN: unreadable on-link prefixes left out: $bad")
        return (all - bad.toSet()).map(RouteSplit::normalise).distinct().sorted()
    }

    private fun underlyingNetwork(): String {
        val cm = getSystemService(ConnectivityManager::class.java)
        for (n in cm.allNetworks) {
            val c = cm.getNetworkCapabilities(n) ?: continue
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (!c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            return when {
                c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
        }
        return "none"
    }

    /**
     * The network dvpnd's own sockets use (this app is outside its VPN): the system default for
     * this app, else the first non-VPN network with internet. Its handle changes on every
     * reconnect, which is how dvpnd sees an airplane flap or a Wi-Fi/mobile handover (Q0249).
     */
    private fun underlyingNetworkId(): String {
        val cm = getSystemService(ConnectivityManager::class.java)
        val active = cm.activeNetwork?.takeIf { n ->
            cm.getNetworkCapabilities(n)?.let {
                !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            } ?: false
        }
        val n = active ?: cm.allNetworks.firstOrNull { n ->
            cm.getNetworkCapabilities(n)?.let {
                !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            } ?: false
        } ?: return "none"
        val c = cm.getNetworkCapabilities(n)
        val kind = when {
            c == null -> "other"
            c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        return "$kind#${n.networkHandle}"
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
    )

    private fun notification(): Notification {
        val live = synchronized(lock) { session }
        val (title, text) = synchronized(lock) {
            when {
                session != null -> getString(R.string.notif_connected) to getString(R.string.notif_connected_text, protocolLabel(session!!))
                held -> getString(R.string.notif_held) to getString(R.string.notif_held_text)
                else -> getString(R.string.notif_ready) to getString(R.string.notif_ready_text)
            }
        }
        val stop = PendingIntent.getService(
            this, 1, Intent(this, DvpnVpnService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        val b = Notification.Builder(this, DvpnApp.CHANNEL_VPN)
        live?.let { protocolLogo(it) }?.let { b.setLargeIcon(android.graphics.drawable.Icon.createWithResource(this, it)) }
        return b
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.notif_turn_off), stop).build())
            .build()
    }

    private fun updateNotification() {
        getSystemService(android.app.NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
        QuickTileService.refresh(this)
    }

    companion object {
        private const val TAG = "ddv-vpn"
        private const val NOTIFICATION_ID = 1
        const val ACTION_START = "network.sentinel.devnetdvpn.START"
        const val ACTION_STOP = "network.sentinel.devnetdvpn.STOP"

        @Volatile var running: DvpnVpnService? = null
            private set

        /** Same display names as src/shared/protocols.ts. */
        fun protocolLabel(id: String): String = when (id.lowercase()) {
            "wireguard" -> "WireGuard"
            "amneziawg" -> "AmneziaWG"
            "openvpn" -> "OpenVPN"
            "v2ray" -> "V2Ray"
            "xray" -> "Xray"
            "hysteria2" -> "Hysteria2"
            else -> id
        }

        /** Bundled logo (docs/ASSETS.md). WireGuard: none, its trademark policy allows the name only. */
        fun protocolLogo(id: String): Int? = when (id.lowercase()) {
            "amneziawg" -> R.drawable.proto_amneziawg
            "openvpn" -> R.drawable.proto_openvpn
            "v2ray" -> R.drawable.proto_v2ray
            "xray" -> R.drawable.proto_xray
            "hysteria2" -> R.drawable.proto_hysteria2
            else -> null
        }

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, DvpnVpnService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, DvpnVpnService::class.java).setAction(ACTION_STOP))
        }
    }
}
