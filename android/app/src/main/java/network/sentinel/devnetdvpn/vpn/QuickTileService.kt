package network.sentinel.devnetdvpn.vpn

import android.content.ComponentName
import android.content.Context
import android.net.VpnService
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

// Quick Settings tile: shows whether the app's VPN is on; a tap turns it on or off.
class QuickTileService : TileService() {
    override fun onStartListening() = render()

    override fun onClick() {
        if (DvpnVpnService.running != null) {
            DvpnVpnService.stop(this)
        } else if (VpnService.prepare(this) == null) {
            DvpnVpnService.start(this)
        }
        render()
    }

    private fun render() {
        val tile = qsTile ?: return
        val on = DvpnVpnService.running?.state()?.let { it.connected || it.held } ?: false
        tile.state = if (DvpnVpnService.running == null) Tile.STATE_INACTIVE else if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.updateTile()
    }

    companion object {
        fun refresh(ctx: Context) = requestListeningState(ctx, ComponentName(ctx, QuickTileService::class.java))
    }
}
