// ─── `daemon` — the VPN service: version, doctor, drivers, init, install, settings, restore ───
// Split from commands.ts (500-line rule); same services as the app's Diagnostics + Settings.
import { str, UsageError } from './args';
import { confirm, need, walletRead, type Cmd } from './commands';
import { restoreNetwork, adoptRunningSession } from '../main/services/connection';
import { snapshot } from '../main/app-state';
import { clearSystemProxy } from '../main/system/proxy';
import { driversStatus, repairDrivers, driverLines } from '../main/system/drivers';
import { isAndroid } from '../main/platform/android-bridge';
import { daemon, daemonInfo, deviceRecord, runDoctor, initDevice, installService } from '../main/daemon/manager';
import { log } from '../main/logger';
import { getDaemonSettings, applyDaemonSettings } from '../main/daemon/settings';
import { dnsDoctorRow, probeDns, dnsProbeProblem } from '../main/system/dns-probe';
import { rivalVpnRow } from '../main/system/tunnels';
import { ownerAddress } from '../main/wallet/vault';
import { DNS_PRESETS, validateSettings, type DaemonSettings, type SplitMode } from '../core/daemon/config';
import { tdvpn } from '../core/chain/amounts';
import { boolFlag, escrowFlag, wholeFlag, FlagError } from '../core/daemon/flags';

/** Flag errors are usage errors (exit 3), raised before anything is asked or applied. */
/** Valid values for every field: used only to check the given flags when no config can be read. */
const VALIDATION_BASE: DaemonSettings = {
  killSwitch: 'off', basis: 'per_gb', dnsServers: ['1.1.1.1'], escrow: '1', prepayBytes: '0', prepaySeconds: '0',
  rpcUrl: 'https://api.devnet.solana.com', rpcWsUrl: 'wss://api.devnet.solana.com',
} as DaemonSettings;

function flagged<T>(fn: () => T): T {
  try { return fn(); } catch (err) { if (err instanceof FlagError) throw new UsageError(err.message); throw err; }
}

export const daemonCmd: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'version';
  if (sub === 'version') {
    const v = await daemon().getVersion();
    o.print(`${v.tag || v.commit}  network ${v.network}  program ${v.programId}  mint ${v.mint}  ${daemonInfo().networkOk ? 'OK' : 'MISMATCH'}`, { ...v, networkOk: daemonInfo().networkOk });
  } else if (sub === 'doctor') {
    const [rows, rival] = await Promise.all([runDoctor(), rivalVpnRow()]);
    const dnsRow = await dnsDoctorRow(getDaemonSettings().settings.dnsServers ?? []);
    if (dnsRow) rows.push(dnsRow);
    // Other VPN adapters are a Windows check; Android has none to compete with.
    if (!isAndroid()) rows.push(rival);
    o.print(rows.map((r) => `${r.level === 'ok' ? 'ok  ' : r.level === 'warn' ? 'warn' : 'FAIL'}  ${r.name.padEnd(28)} ${r.detail}`).join('\n'), rows);
  } else if (sub === 'drivers') {
    const v = await driversStatus();
    if (!v.supported) { o.print('VPN drivers are managed by the Windows app only.', v); return; }
    if (!v.live) throw new Error(v.error ?? 'driver check failed');
    const tail = v.live.ok ? 'All VPN drivers are ready.' : 'Some drivers are missing: run "daemon repair-drivers --yes".';
    o.print([...driverLines(v.live), tail].join('\n'), v);
  } else if (sub === 'repair-drivers') {
    confirm(a, o, isAndroid() ? 'Re-link the protocol programs bundled with the app. The VPN engine restarts only if one is missing.' : 'Install or repair WireGuard, AmneziaWG and OpenVPN 2.6 (one administrator prompt). Drivers already installed are left alone.');
    const r = await repairDrivers();
    const lines = r.view.live ? driverLines(r.view.live) : [];
    if (!r.ok) throw new Error([r.error, ...lines].join('\n'));
    o.print([...lines, 'All VPN drivers are ready.'].join('\n'), r);
  } else if (sub === 'init') {
    const owner = ownerAddress();
    if (!owner) throw new UsageError('create or import a wallet first');
    const r = await initDevice(owner);
    if (!r.ok) throw new Error(r.error);
    const next = `device setup --yes${isAndroid() ? '' : ', then daemon install --yes'}`;
    o.print(r.reused
      ? `Device ${r.device} is already this wallet's device; its key is kept. Next, if not done yet: ${next}`
      : `Device ${r.device} created for this wallet. Next: ${next}`, r);
  } else if (sub === 'install') {
    if (!ownerAddress()) throw new Error('Create or import a wallet, then run "device setup --yes": the service will not start without a funded, permitted device.');
    // Offline repair (port of the macOS app 0790fc2): when the balances cannot be read but this wallet already
    // set up a device here, the service is reinstalled anyway (it needs no network to start).
    let w: Awaited<ReturnType<typeof walletRead>> | null = null;
    try {
      w = await walletRead();
    } catch (readErr) {
      if (deviceRecord()?.owner !== ownerAddress()) throw readErr;
      log.warn('daemon install: balances unreadable, repairing for the recorded device', { err: (readErr as Error).message });
    }
    if (w && !w.ready) throw new Error('Run "device setup --yes" first: the service will not start without a funded, permitted device.');
    confirm(a, o, 'Install and start the VPN service (one administrator prompt). With kill switch on, a stopped session blocks internet until you disconnect or restore network.');
    const r = await installService();
    if (!r.ok) throw new Error(r.error);
    o.print('Service installed and running.', r);
  } else if (sub === 'settings') {
    const s = getDaemonSettings();
    // Same units as the flags: escrow in tDVPN, prepay in MB / minutes.
    const human = (k: string, v: unknown): string => {
      if (Array.isArray(v)) return v.join(', ');
      if (k === 'split' && v && typeof v === 'object') {
        const sp = v as { mode: string; apps: string[]; routes: string[] };
        return sp.mode === 'off' ? 'off' : `${sp.mode}  apps: ${sp.apps.join('; ') || 'none'}  routes: ${sp.routes.join(', ') || 'none'}`;
      }
      // Not what this app/CLI pays: connect sizes the deposit from the node price (UI session 2026-10-22).
      if (k === 'escrow') return `${tdvpn(String(v))} tDVPN (fallback for dvpnd-only sessions; connect sizes its own deposit)`;
      if ((k === 'prepayBytes' || k === 'prepaySeconds') && String(v) === '0') return "the node's minimum";
      if (k === 'prepayBytes') return `${Number(v) / 1e6} MB`;
      if (k === 'prepaySeconds') return `${Number(v) / 60} min`;
      return String(v);
    };
    // Unset values are left out ("split undefined"), and so are the desktop-only split and
    // whole-device rows on Android (the VPN service applies split there: `split show`).
    const desktopOnly = new Set(['split', 'wholeDevice']);
    const shown = Object.entries(s.settings).filter(([k, v]) => v !== undefined && !(isAndroid() && desktopOnly.has(k)));
    o.print(s.readable ? shown.map(([k, v]) => `${k.padEnd(14)} ${human(k, v)}`).join('\n') : 'Service settings are not readable as this user.', s);
  } else if (sub === 'set') {
    const cur = getDaemonSettings();
    const dns = str(a, 'dns');
    if (dns && !DNS_PRESETS[dns] && /[g-z]/i.test(dns)) throw new UsageError(`unknown DNS preset "${dns}": use ${Object.keys(DNS_PRESETS).join(', ')} or IP addresses`);
    // Anything but true/false used to be stored as false without a word.
    const lan = str(a, 'allow-lan');
    if (lan && lan !== 'true' && lan !== 'false') throw new UsageError(`--allow-lan must be true or false, not "${lan}"`);
    // Android: apps and addresses are chosen with `split set` / `split routes` (the VPN service),
    // and every protocol already covers the whole phone; the desktop flags would mean nothing.
    if (isAndroid()) for (const k of ['whole-device', 'split-mode', 'split-apps', 'split-routes']) {
      if (str(a, k) !== undefined) throw new UsageError(`--${k} is for the desktop app; on Android use: split set / split routes`);
    }
    const next = {
      ...cur.settings,
      ...(str(a, 'kill-switch') ? { killSwitch: str(a, 'kill-switch') } : {}),
      ...(str(a, 'allow-lan') ? { allowLan: flagged(() => boolFlag('allow-lan', str(a, 'allow-lan')!)) } : {}),
      // V2Ray/Xray: whole computer through a TUN adapter (true) or only apps using the SOCKS proxy (false).
      ...(str(a, 'whole-device') ? { wholeDevice: flagged(() => boolFlag('whole-device', str(a, 'whole-device')!)) } : {}),
      ...(dns ? { dnsServers: DNS_PRESETS[dns]?.servers ?? dns.split(',').map((x) => x.trim()) } : {}),
      // netsh = set the VPN's DNS on Windows during a session; none = never touch system DNS.
      ...(str(a, 'dns-mode') ? { dnsMode: str(a, 'dns-mode') } : {}),
      ...(str(a, 'basis') ? { basis: str(a, 'basis') } : {}),
      ...(str(a, 'rpc') ? { rpcUrl: str(a, 'rpc'), rpcWsUrl: str(a, 'rpc')!.replace(/^https:/, 'wss:') } : {}),
      ...(str(a, 'rpc-ws') ? { rpcWsUrl: str(a, 'rpc-ws') } : {}),
      ...(str(a, 'escrow') ? { escrow: flagged(() => escrowFlag(str(a, 'escrow')!)) } : {}),
      ...(str(a, 'prepay-mb') ? { prepayBytes: flagged(() => wholeFlag('prepay-mb', str(a, 'prepay-mb')!, 1_000_000n)) } : {}),
      ...(str(a, 'prepay-minutes') ? { prepaySeconds: flagged(() => wholeFlag('prepay-minutes', str(a, 'prepay-minutes')!, 60n)) } : {}),
    } as DaemonSettings;
    // Split tunnelling: --split-mode off|include|exclude, --split-apps "C:\a.exe;C:\b.exe" (or none),
    // --split-routes "10.0.0.0/8,1.2.3.4/32" (or none). Unset flags keep the current values.
    if (str(a, 'split-mode') || str(a, 'split-apps') || str(a, 'split-routes')) {
      const list = (v: string | undefined, sep: string, cur: string[]): string[] =>
        v === undefined ? cur : v === 'none' ? [] : v.split(sep).map((x) => x.trim()).filter(Boolean);
      const cur = next.split ?? { mode: 'off' as const, apps: [], routes: [] };
      next.split = {
        mode: (str(a, 'split-mode') ?? cur.mode) as SplitMode,
        apps: list(str(a, 'split-apps'), ';', cur.apps),
        routes: list(str(a, 'split-routes'), ',', cur.routes),
      };
    }
    // No readable service config: still refuse bad values first (exit 3), checked against a valid
    // baseline, then say what is wrong. A clean Win11 VM said "not readable as this user" for a
    // service that was never set up, and refused nothing (vm-phase2 settings-e2e, 2026-10-22).
    if (!cur.readable) {
      try { validateSettings({ ...VALIDATION_BASE, ...next }); } catch (err) { throw new UsageError((err as Error).message); }
      throw new Error(cur.missing
        ? 'The VPN service is not set up on this computer yet. Finish device setup in the app (or run: devnet-dvpn daemon install), then change its settings.'
        : 'Service settings are not readable as this user.');
    }
    // A DNS choice that does not answer gives a session with no names (Handshake preset, 2026-10-22).
    if (dns) { const p = dnsProbeProblem(await probeDns(next.dnsServers ?? [])); if (p) process.stderr.write(`warning: ${p}\n`); }
    // Validate before asking for --yes: a bad value must never reach the elevated step.
    // The https rule is for an RPC being set here; the stored one (an http gate) is carried through (Q0478).
    const rpcTouched = str(a, 'rpc') !== undefined || str(a, 'rpc-ws') !== undefined;
    try { validateSettings(next, { skipRpc: !rpcTouched }); } catch (err) { throw new UsageError((err as Error).message); }
    // Applying restarts dvpnd, which ends a live session (the app's Settings says so too). Say so
    // before and after: a silent end looked like a tunnel leak (F-C2-1, ported from devnet-dvpn e481865).
    await adoptRunningSession();
    const live = !!snapshot().session;
    const ends = live ? '. This ENDS the current VPN session; connect again after' : '';
    confirm(a, o, `${isAndroid() ? 'Apply these settings and restart the VPN engine' : 'Apply service settings and restart it (one administrator prompt)'}${ends}:\n${JSON.stringify(next, null, 2)}`);
    const r = await applyDaemonSettings(next);
    if (!r.ok) throw new Error(r.error);
    // Desktop: a session that ended with the restart can leave our system proxy on. Android never sets one.
    if (live && !isAndroid()) await clearSystemProxy();
    o.print(live ? 'Applied and restarted. The VPN session ended with the restart: connect again.' : 'Applied and restarted.', { ...r, sessionEnded: live });
  } else if (sub === 'dns-check') {
    // Same probe as the Settings DNS picker: --dns preset|ip,ip, or the service's current servers.
    const dns = str(a, 'dns');
    if (dns && !DNS_PRESETS[dns] && /[g-z]/i.test(dns)) throw new UsageError(`unknown DNS preset "${dns}": use ${Object.keys(DNS_PRESETS).join(', ')} or IP addresses`);
    const servers = dns ? DNS_PRESETS[dns]?.servers ?? dns.split(',').map((x) => x.trim()) : getDaemonSettings().settings.dnsServers ?? [];
    const rows = await probeDns(servers);
    const problem = dnsProbeProblem(rows);
    o.print(rows.map((r) => `${r.server.padEnd(16)} ${r.ok ? `answers (${r.ms} ms)` : 'no answer'}`).join('\n') || 'No DNS servers set.', { rows, problem });
    if (problem) throw new Error(problem); // exit 1: scripts can gate on it
  } else if (sub === 'restore-network') {
    const r = await restoreNetwork();
    need(r);
    o.print('Network restored.', r);
  } else throw new UsageError(`unknown: daemon ${sub}`);
};
