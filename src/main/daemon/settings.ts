// ─── Daemon settings (D4, F14, F15, F16b, F18) ───
// Kill switch, DNS, allow_lan, basis/escrow/prepay, the daemon's RPC URL and V2Ray/Xray
// whole-device mode live in the daemon's own TOML, not in gRPC. We read the live files when
// Windows lets a standard user read them, render + validate new ones (core/daemon/config),
// stage them under userData, and apply with one UAC prompt + service restart.
import fs from 'node:fs';
import path from 'node:path';
import { parseSettings, parseWholeDevice, readToml, renderConfig, renderConfigs, renderServiceConfig, TUN_SERVICES, upgradeClientDns, validateSettings, type DaemonSettings } from '../../core/daemon/config';
import { CONFIG_FILE } from '../../core/daemon/layout';
import { splitNotApplied } from '../../core/session/state';
import { DEFAULT_DAEMON_HOME, daemonInfo, deviceRecord, relinkDaemon, restartAndroidDaemon, scriptPath } from './manager';
import { isAndroid } from '../platform/android-bridge';
import { runElevated } from '../system/elevate';
import { log } from '../logger';
import { getHost } from '../host';
import { PREPAY_CAP_BYTES, PREPAY_CAP_SECONDS, prepayOverCap } from '../../shared/prepay-cap';

function home(): string {
  return deviceRecord()?.home ?? DEFAULT_DAEMON_HOME;
}

/** cb33 layout (Android): one config.toml in the instance home, per-service files at <home>/<service>. */
const cb33 = (): boolean => isAndroid();

/** V2Ray/Xray service configs that exist (a service list without them has none). */
function readServiceConfigs(): Partial<Record<(typeof TUN_SERVICES)[number], string>> {
  const out: Partial<Record<(typeof TUN_SERVICES)[number], string>> = {};
  for (const s of TUN_SERVICES) {
    const f = cb33() ? path.join(home(), s, CONFIG_FILE) : path.join(home(), 'client', s, 'config.toml');
    try {
      if (fs.existsSync(f)) out[s] = fs.readFileSync(f, 'utf8');
    } catch (err) {
      log.warn('service config not readable as this user', { service: s, err: (err as Error).message });
    }
  }
  return out;
}

function readLive(): { root: string; client: string } | null {
  try {
    if (cb33()) {
      // The one file given as both halves: its root ([rpc]) and client keys never share a name (as the Linux app).
      const text = fs.readFileSync(path.join(home(), CONFIG_FILE), 'utf8');
      return { root: text, client: text };
    }
    return {
      root: fs.readFileSync(path.join(home(), 'config.toml'), 'utf8'),
      client: fs.readFileSync(path.join(home(), 'client', 'config.toml'), 'utf8'),
    };
  } catch (err) {
    log.warn('daemon config not readable as this user', { err: (err as Error).message });
    return null;
  }
}

/**
 * True when this V2Ray/Xray session runs in whole-device mode (Windows TUN): every app is
 * already covered, so the app must not also set the system proxy (that would send proxy-aware
 * apps through the SOCKS port whatever the split tunnelling choice says).
 */
export function serviceUsesTun(service: string | null | undefined): boolean {
  if (process.platform !== 'win32' || !service) return false;
  const s = service.toLowerCase();
  if (!(TUN_SERVICES as readonly string[]).includes(s)) return false;
  const toml = readServiceConfigs()[s as (typeof TUN_SERVICES)[number]];
  return toml !== undefined && parseWholeDevice([toml]) === true;
}

/**
 * The split tunnelling dvpnd applies to a session of this protocol: [split] from the client
 * config, filtered by what this dvpnd build does (splitNotApplied). null = full tunnel.
 */
export function splitForSession(service: string | null | undefined): 'include' | 'exclude' | null {
  const live = readLive();
  if (!live || !service) return null;
  const mode = readToml(live.client, 'split', 'mode');
  if (mode !== 'include' && mode !== 'exclude') return null;
  const list = (k: string): string[] => { const v = readToml(live.client, 'split', k); return Array.isArray(v) ? v : []; };
  const apps = list('apps');
  if (!apps.length && !list('routes').length) return null;
  const why = splitNotApplied({
    daemonVersion: daemonInfo().version,
    service,
    killSwitch: String(readToml(live.client, 'network', 'kill_switch') ?? 'on'),
    wholeDevice: (TUN_SERVICES as readonly string[]).includes(service.toLowerCase()) ? serviceUsesTun(service) : undefined,
    hasApps: apps.length > 0,
    platform: process.platform,
  });
  if (why) log.info('split tunnelling not in effect for this session', { service, why });
  return why ? null : mode;
}

/** missing = the service was never set up on this computer (no config file), not a permission problem. */
export function getDaemonSettings(): { readable: boolean; missing?: boolean; settings: Partial<DaemonSettings> } {
  const live = readLive();
  if (!live) return { readable: false, missing: !fs.existsSync(path.join(home(), 'config.toml')), settings: {} };
  const wholeDevice = parseWholeDevice(Object.values(readServiceConfigs()));
  return { readable: true, settings: { ...parseSettings(live.root, live.client), ...(wholeDevice !== undefined ? { wholeDevice } : {}) } };
}

/**
 * Android, once per app start with no session (a restart would end it): write an older preset's DNS
 * list as its current one into dvpnd's file and restart dvpnd (Q0365). Desktop is left to its own
 * install-time migration. Returns true when it rewrote the file.
 */
export async function upgradeSavedDnsAndroid(): Promise<boolean> {
  if (!isAndroid()) return false;
  const live = readLive();
  const next = live ? upgradeClientDns(live.client) : null;
  if (!next) return false;
  const file = path.join(home(), CONFIG_FILE);
  fs.writeFileSync(`${file}.new`, next, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(`${file}.new`, file);
  log.info('upgraded the saved DNS list to the current preset (Q0365)', { servers: readToml(next, 'network', 'dns_servers') });
  const r = await restartAndroidDaemon();
  if (!r.ok) log.warn('dvpnd restart after the DNS upgrade failed', { err: r.error });
  return true;
}

export async function applyDaemonSettings(next: DaemonSettings): Promise<{ ok: boolean; error?: string }> {
  const live = readLive();
  // The https rule applies to an RPC being changed, not to the stored one carried through (Q0478).
  const stored = live ? parseSettings(live.root, live.client) : {};
  validateSettings(next, { skipRpc: !!live && next.rpcUrl === stored.rpcUrl && next.rpcWsUrl === stored.rpcWsUrl });
  // Q0338: dvpnd caps the prepay without a word; say it once here.
  const capped = prepayOverCap(next.prepayBytes, next.prepaySeconds);
  if (capped.length) log.warn('prepay above the service cap; dvpnd will use the cap', { capped, capBytes: String(PREPAY_CAP_BYTES), capSeconds: String(PREPAY_CAP_SECONDS) });
  if (!live) return { ok: false, error: 'This app cannot read the VPN service settings on this account. Run the app once as administrator or re-run setup.' };
  if (isAndroid()) {
    // Android: the home is the app's own files, one cb33 config.toml. Write in place (atomic rename),
    // then restart dvpnd.
    const file = path.join(home(), CONFIG_FILE);
    fs.writeFileSync(`${file}.new`, renderConfig(live.client, next, { android: true }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(`${file}.new`, file);
    log.info('daemon settings written (android)');
    return restartAndroidDaemon();
  }
  const out = renderConfigs(live.root, live.client, next);
  const staged = path.join(getHost().dataDir, 'staged');
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'config.toml'), out.root, 'utf8');
  fs.writeFileSync(path.join(staged, 'client.config.toml'), out.client, 'utf8');
  // Whole-device mode: only the service configs that exist, only when the setting is given.
  for (const s of TUN_SERVICES) fs.rmSync(path.join(staged, `${s}.config.toml`), { force: true });
  if (next.wholeDevice !== undefined) {
    for (const [s, text] of Object.entries(readServiceConfigs())) {
      fs.writeFileSync(path.join(staged, `${s}.config.toml`), renderServiceConfig(text, next.wholeDevice), 'utf8');
    }
  }
  const r = await runElevated(scriptPath('apply-daemon-config.ps1'), { Staged: staged, DaemonHome: home() });
  log.info('daemon settings apply', { status: r.status, detail: r.detail });
  relinkDaemon();
  return r.status === 'ok' ? { ok: true } : { ok: false, error: r.detail };
}
