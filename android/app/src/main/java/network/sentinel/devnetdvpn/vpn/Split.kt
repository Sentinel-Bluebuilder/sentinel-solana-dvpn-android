package network.sentinel.devnetdvpn.vpn

import android.content.Context
import android.content.pm.PackageManager
import android.net.VpnService
import android.util.Log

// ─── Split tunnelling (per app) ───
// all     = every app through the VPN except this one
// include = only the listed apps through the VPN
// exclude = every app except the listed ones (and this one)
// This app is never inside the VPN (ANDROID-PORT D-A2). Works the same for all six protocols.
// By destination (routeMode / routes, same three modes): see RouteSplit.kt.

data class Split(
    val mode: String,
    val packages: Set<String>,
    val routeMode: String = MODE_ALL,
    val routes: Set<String> = emptySet(),
) {
    fun apply(b: VpnService.Builder, self: String) {
        when (mode) {
            MODE_INCLUDE -> {
                val apps = packages - self
                // An empty include list would route every app; refuse to silently widen it.
                require(apps.isNotEmpty()) { "split tunnelling is set to 'only these apps' but no app is selected" }
                // Same if every chosen app was uninstalled since: no allowed app = every app.
                val added = apps.count { addSafe { b.addAllowedApplication(it) } }
                require(added > 0) { "split tunnelling is set to 'only these apps' but none of them is installed" }
            }
            else -> {
                b.addDisallowedApplication(self)
                if (mode == MODE_EXCLUDE) (packages - self).forEach { addSafe { b.addDisallowedApplication(it) } }
            }
        }
    }

    /** True when the app was added; false when it is no longer installed. */
    private fun addSafe(add: () -> Unit): Boolean = try {
        add()
        true
    } catch (e: PackageManager.NameNotFoundException) {
        Log.w("ddv-split", "skipping an app that is no longer installed", e)
        false
    }

    companion object {
        const val MODE_ALL = "all"
        const val MODE_INCLUDE = "include"
        const val MODE_EXCLUDE = "exclude"
        private const val PREFS = "split"

        fun load(ctx: Context): Split {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val modes = setOf(MODE_ALL, MODE_INCLUDE, MODE_EXCLUDE)
            val mode = p.getString("mode", MODE_ALL).takeIf { it in modes } ?: MODE_ALL
            val routeMode = p.getString("routeMode", MODE_ALL).takeIf { it in modes } ?: MODE_ALL
            return Split(mode, p.getStringSet("packages", emptySet())!!.toSet(), routeMode, p.getStringSet("routes", emptySet())!!.toSet())
        }

        fun save(ctx: Context, s: Split) {
            require(s.mode in setOf(MODE_ALL, MODE_INCLUDE, MODE_EXCLUDE)) { "unknown split mode ${s.mode}" }
            require(s.routeMode in setOf(MODE_ALL, MODE_INCLUDE, MODE_EXCLUDE)) { "unknown split mode ${s.routeMode}" }
            require(s.routes.size <= RouteSplit.MAX_ROUTES) { "at most ${RouteSplit.MAX_ROUTES} addresses" }
            val routes = s.routes.map(RouteSplit::normalise).toSet()
            require(s.routeMode != MODE_INCLUDE || routes.isNotEmpty()) { "'only these addresses' needs at least one address" }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("mode", s.mode).putStringSet("packages", s.packages)
                .putString("routeMode", s.routeMode).putStringSet("routes", if (s.routeMode == MODE_ALL) emptySet() else routes).apply()
        }
    }
}
