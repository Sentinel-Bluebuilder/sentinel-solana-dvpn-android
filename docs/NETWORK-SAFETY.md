# Network safety — everything that can touch this computer's internet

The owner's rule: nothing in this app, its CLI or its tests may leave a computer
without internet. This file lists **every** code path that changes host networking,
the guard on each, and how it is tested. A new path that is not listed here is a bug.

## The paths

| # | What changes | Who changes it | When it is undone | Guard | Tested by |
|---|---|---|---|---|---|
| 1 | Tunnel, routes, kill-switch firewall rules, DNS | `dvpnd` service only (the app never touches them) | Session stop (Disconnect, quit, Restore network); daemon releases a non-persist kill switch after its 5 reconnect attempts fail | App quits only after `StopSession` (10 s cap); `Restore network` in Connect + Diagnostics + CLI `daemon restore-network`; `dns_revert_failed` → red banner with Restore network | WSL netns rig (`scripts/e2e/wsl-rig.sh`): restore-network left no nft tables; Windows egress checked 200 before/after every run |
| 2 | Kill-switch **mode** (`off` / `on` / `persist`) | User, Settings → VPN service (elevated `apply-daemon-config.ps1` + service restart) | User changes it back | Daemon default is `on` (blocks only while a session is up or reconnecting). `persist` copy says plainly it can leave you offline. Split tunnelling requires `off` and says so | `validateSettings` unit tests; CLI `daemon set` stops for `--yes` (cli-e2e daemon tier) — **never applied on the dev laptop** |
| 3 | Windows system proxy (HKCU `ProxyEnable`/`ProxyServer`) | App, only on the user's toggle **and only while a V2Ray/Xray session exposes a loopback SOCKS endpoint** | Session end (any reason), Disconnect, Restore network, app quit, next app start (crash recovery), uninstall | Refuses non-loopback endpoints; refuses with no SOCKS session; saves the user's own values first and restores them exactly; only undoes the value if it is still ours | `tests/unit/main-services.test.ts` (fake registry: save/restore/only-ours, non-loopback refusal); cli-e2e local tier asserts the real registry has no `socks=127…`; uninstall script tested against a non-matching backup (registry unchanged) |
| 4 | The `dvpnd` Windows service | One elevated step in first run (`setup-daemon.ps1`), after device setup | Uninstall (`uninstall-cleanup.ps1` via `build/installer.nsh`): graceful stop → session ends, kill switch + DNS released → `service uninstall` | Never installed by tests on this machine; cli-e2e asserts no running `dvpnd` service | cli-e2e local tier |
| 5 | Connect on launch | App, opt-in setting | — | Once per start; never when the daemon still holds a session (adopted instead) or a previous run left a Restore-network warning; never in UI smoke runs | code review (`services/auto-connect.ts`) |

Nothing else in the codebase calls `netsh`, `route`, `reg add`, firewall APIs or
adapter APIs. Check with:
`grep -rnE "netsh|route add|New-NetFirewall|execFile\(.reg|Set-ItemProperty|Set-DnsClient" src resources/scripts`
(expected hits: only `src/main/system/proxy.ts` and `uninstall-cleanup.ps1`).

## Test rules (this laptop)
- Paid sessions run **only** in the WSL netns rig. The tunnel and kill switch live in
  namespace `dvpnapp`; Windows and the WSL host namespace are never routed.
- `wsl-rig.sh client` = client daemon only (shared node untouched). `up` moves shared
  node `6AaXvh…`'s API — message the #1b / #29 sessions first, always `down` after.
- Never on this laptop: `daemon install --yes`, `daemon set --yes`, `proxy on --yes`
  with a real session, or any Windows-side `dvpnd start`.

## Known residual risks
- `persist` kill switch + a daemon that dies uncleanly can leave rules until the next
  service start (daemon re-applies, then releases on stop). Upstream gap #5 asks for a
  watchdog. The UI warns before `persist` is chosen.
- A per-machine uninstall restores the proxy of the account that approved UAC. With
  over-the-shoulder admin credentials that is the admin, not the signed-in user; the
  user's proxy is then restored on their next app start, or by hand.
- The Windows WireGuard path has not run end to end (needs a disposable VM; this laptop
  is Windows Home). Until it has, a Windows release is blocked (TEST-PLAN).

## Android (the Android app) — everything that can touch the phone's internet

| # | What changes | Who changes it | When it is undone | Guard | Tested by |
|---|---|---|---|---|---|
| A1 | The VPN interface (VpnService), routes, split apps/addresses, DNS servers | `DvpnVpnService.establish` on dvpnd's request (platform socket, peer-uid checked) | `release` on session end; `onRevoke` (another VPN / user turned it off); service stop | This app's own UID is always outside the VPN (paying always works); a start that fails after Establish releases (`TestUpReleasesInterfaceWhenConfigFails`) | proto-check, grid connect/disconnect cells (direct after every disconnect) |
| A2 | Kill switch **hold** (interface kept with no route out) | dvpnd `hold(true)` with `kill_switch = on/persist` during a drop or switch; persist also after restarts | Reconnect, Disconnect, Restore network (`daemon restore-network`), `hold(false)` | The page shows **Blocking internet** + Restore network from the service's own `held` flag (bridge `vpnState`, 520a910) — a reachability check can't see it, the app bypasses the VPN | grid crash cells (off → direct; on/persist → 0 IPv4 answers until Disconnect), edge protokill/svcrestart, `ui-pages.sh ks` (0 direct samples, page state, Restore on the page) |
| A3 | Allow local network | dvpnd `allow_lan` → platform spec → `RouteSplit.LAN` excluded (native excludeRoute on API 33+, complement below) | Setting off + next connect | Ranges on the page = `RouteSplit.LAN` (unit test reads the Kotlin) | grid allowlan cell (10.0.2.2 reachable only when on), JVM `RouteSplitTest` |
| A4 | Always-on VPN / Block connections without VPN | The **user**, in Android settings (the app only opens the screen and reads the state) | The user | Read-only in the app (`vpnSystemState`) | `lockdown-check.sh` 15/15 |

Test rules on Android: paid sessions, kill-switch and drop tests run **only** on the cloud
emulator (`test-host`) or Firebase Test Lab phones — never on a personal phone. Nodes are
the Windows app's on `test-host`; node-down and bad paths are made with VM iptables/netem, never by
stopping a node.
