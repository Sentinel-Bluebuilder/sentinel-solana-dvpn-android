// ─── Daemon manager (D1, D5, F1, F4.5) ───
// The app is unelevated; dvpnd runs as a LocalSystem service. A standard user
// cannot open the daemon pipe with GENERIC_WRITE (UPSTREAM-GAPS #10), so we run
// resources/bin/pipe-bridge.exe as the user: it dials the daemon with the exact
// rights the pipe grants and re-serves it on a per-user pipe, printing
// "ready <path>". gRPC goes over that pipe. The bridge exits when our stdin closes.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DaemonClient, DaemonError, DEFAULT_WINDOWS_PIPE, pipeTarget, type DaemonVersion } from '../../core/daemon/client';
import { MINT, PROGRAM_ID } from '../../core/chain/idl';
import type { DaemonInfo } from '../../shared/types';
import { readJson, writeJson } from '../store';
import { runElevated, type ElevatedResult } from '../system/elevate';
import { log } from '../logger';
import { getHost } from '../host';
import { daemonLinkCopy } from '../../core/daemon/link-copy';
import { carrySettings, readToml, renderServiceConfig, TUN_SERVICES } from '../../core/daemon/config';
import { isAndroid, bridgeCall } from '../platform/android-bridge';
import { carrySettingsInto } from '../../core/daemon/config';
import { CONFIG_FILE, KEYS_DIR, LEGACY_DEVICE_KEY, OPERATOR_KEY, doctorArgs, initArgs, keyListArgs, operatorKey } from '../../core/daemon/layout';

export const DEFAULT_DAEMON_HOME = process.env.DVPN_DAEMON_HOME || 'C:\\ProgramData\\dvpnd\\client';
const DEVICE_FILE = 'device.json';

// ─── Paths ───
export function resourcesDir(): string {
  return getHost().resourcesDir;
}
export const binPath = (name: string): string => path.join(resourcesDir(), 'bin', name);
export const scriptPath = (name: string): string => path.join(resourcesDir(), 'scripts', name);
export const protoPath = (): string => path.join(resourcesDir(), 'daemon.proto');
export function dvpndPath(): string {
  return process.env.DVPND_BIN && fs.existsSync(process.env.DVPND_BIN) ? process.env.DVPND_BIN : binPath(process.platform === 'win32' ? 'dvpnd.exe' : 'dvpnd');
}

// dvpnd finds V2Ray/Xray only on PATH (go-sdk service.LookPath). Each lives in its own
// folder because both ship different geoip/geosite files under the same names. The
// service gets these on its own PATH at install (setup-daemon.ps1); the doctor too.
export const PROTOCOL_BIN_DIRS = ['v2ray', 'xray', 'hysteria2'];
export const protocolBinDirs = (): string[] => PROTOCOL_BIN_DIRS.map((d) => binPath(d)).filter((d) => fs.existsSync(d));
const withProtocolPath = (): NodeJS.ProcessEnv => {
  const extra = protocolBinDirs();
  return extra.length ? { ...process.env, PATH: [process.env.PATH ?? '', ...extra].join(path.delimiter) } : process.env;
};

interface DeviceRecord { device: string; home: string; owner: string; at: number }

// ─── State ───
let bridge: ChildProcess | null = null;
let client: DaemonClient | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let backoffMs = 2000;
let stopping = false;
const info: DaemonInfo = { reachable: false, bridge: 'stopped', version: null, networkOk: null, error: null, home: null, device: null };
const listeners = new Set<() => void>();

export const onDaemonChange = (fn: () => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (): void => { for (const l of listeners) l(); };

export function daemonInfo(): DaemonInfo {
  const d = readJson<DeviceRecord | null>(DEVICE_FILE, null);
  return { ...info, home: d?.home ?? null, device: d?.device ?? null };
}

export function deviceRecord(): DeviceRecord | null {
  return readJson<DeviceRecord | null>(DEVICE_FILE, null);
}

/** The connected gRPC client, or a clear error the UI can show. */
export function daemon(): DaemonClient {
  if (!client || !info.reachable) throw new DaemonError(Object.assign(new Error(info.error ?? 'The VPN service is not running.'), { code: 14, details: info.error ?? 'The VPN service is not running.' }) as Error, 'daemon');
  return client;
}

// ─── Bridge lifecycle ───
/** DVPN_DAEMON_PIPE overrides the daemon's control pipe (a foreground test daemon). */
export const daemonPipe = (): string => process.env.DVPN_DAEMON_PIPE || DEFAULT_WINDOWS_PIPE;

/** Resolves once the first attach attempt finished (success or not). */
let firstAttach: Promise<void> = Promise.resolve();
let resolveFirst: (() => void) | null = null;
export const daemonReady = (timeoutMs = 10_000): Promise<void> => Promise.race([firstAttach, new Promise<void>((r) => setTimeout(r, timeoutMs))]);

export function startDaemonLink(): void {
  stopping = false;
  firstAttach = new Promise((r) => { resolveFirst = r; });
  // DVPN_DAEMON_TARGET=host:port — a TCP-bridged daemon (the WSL test rig). Test/dev only.
  if (process.env.DVPN_DAEMON_TARGET) {
    info.bridge = 'missing';
    void attach(process.env.DVPN_DAEMON_TARGET);
    return;
  }
  const exe = binPath('pipe-bridge.exe');
  if (process.env.DVPN_NO_BRIDGE === '1' || !fs.existsSync(exe)) {
    info.bridge = 'missing';
    log.warn('no pipe bridge; dialling the daemon pipe directly (works only elevated)');
    void attach(pipeTarget(daemonPipe()));
    return;
  }
  const child = spawn(exe, ['-daemon', daemonPipe()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  bridge = child;
  info.bridge = 'running';
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const m = /^ready (.+)$/.exec(line.trim());
    if (m) void attach(pipeTarget(m[1]));
  });
  // stderr arrives in small chunks (a Go panic is written word by word): gather it for a moment
  // so one message is one log line.
  let errBuf = '';
  let errTimer: NodeJS.Timeout | null = null;
  const flushErr = (): void => {
    errTimer = null;
    const t = errBuf.trim();
    errBuf = '';
    if (!t) return;
    info.error = daemonLinkCopy(t);
    log.warn('pipe-bridge', { stderr: t.slice(0, 1500) });
  };
  child.stderr!.on('data', (d: Buffer) => {
    errBuf += d.toString();
    if (!errTimer) errTimer = setTimeout(flushErr, 150);
  });
  child.on('exit', (code) => {
    if (errTimer) clearTimeout(errTimer);
    flushErr();
    log.warn('pipe-bridge exited', { code });
    if (resolveFirst) { resolveFirst(); resolveFirst = null; }
    bridge = null;
    detach();
    info.bridge = 'stopped';
    emit();
    if (!stopping) scheduleRestart();
  });
  child.on('error', (err) => {
    info.bridge = 'error';
    info.error = 'A part of this app is missing or blocked (pipe-bridge). Reinstall the app.';
    log.error('pipe-bridge spawn failed', err);
    emit();
  });
}

function scheduleRestart(): void {
  if (restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startDaemonLink();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}

async function attach(target: string): Promise<void> {
  detach();
  client = new DaemonClient(target, protoPath());
  try {
    const v = await client.getVersion();
    info.reachable = true;
    info.version = v.tag || v.commit || 'unknown';
    info.networkOk = networkMatches(v);
    info.error = info.networkOk ? null : `The VPN service is set up for a different network (${v.network}). This app is devnet only.`;
    backoffMs = 2000;
    log.info('daemon attached', { version: info.version, network: v.network, networkOk: info.networkOk });
    startHeartbeat(target);
  } catch (err) {
    info.reachable = false;
    info.error = daemonLinkCopy((err as Error).message);
    log.warn('daemon attach failed', { err: (err as Error).message, retryInMs: backoffMs });
    // The bridge is still up but the service did not answer (busy starting, slow machine). Without
    // a retry the app stayed on "Install service" for an installed service until restarted
    // (VM ui-win-1 2026-10-22, e2-medium: "The VPN service did not answer in time").
    scheduleReattach(target);
  }
  emit();
  if (resolveFirst) { resolveFirst(); resolveFirst = null; }
}

// ─── Heartbeat ───
// The pipe-bridge outlives the service: a stopped or crashed dvpnd left `reachable` true until the
// next call failed, so the app never said "not answering" (VM ui-win-1 2026-10-22, service stopped
// mid-session). One local GetVersion every 10 s; two misses in a row = gone, then the normal
// reattach backoff takes over (one slow answer while the service is busy is not "gone").
export const HEARTBEAT_MS = 10_000;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatMisses = 0;
function startHeartbeat(target: string): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const c = client;
    if (!c || !info.reachable || stopping) return;
    c.getVersion().then(
      () => { heartbeatMisses = 0; },
      (err) => {
        if (client !== c || !info.reachable) return;
        heartbeatMisses += 1;
        // Android dials dvpnd directly on its own socket: one miss means it is gone (killed or
        // crashed), and the kill switch page must say "Blocking" within seconds (ui-pages ks, v7).
        if (heartbeatMisses < (isAndroid() ? 1 : 2)) return;
        log.warn('daemon heartbeat lost', { err: (err as Error).message });
        heartbeatMisses = 0;
        stopHeartbeat();
        info.reachable = false;
        info.error = daemonLinkCopy((err as Error).message);
        emit();
        scheduleReattach(target);
      },
    );
  }, HEARTBEAT_MS);
  heartbeatTimer.unref(); // never keeps a CLI process alive
}
function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  heartbeatMisses = 0;
}

let reattachTimer: NodeJS.Timeout | null = null;
function scheduleReattach(target: string): void {
  if (reattachTimer || stopping) return;
  const wait = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 30_000);
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (!stopping && !info.reachable) void attach(target);
  }, wait);
  reattachTimer.unref?.(); // a one-shot CLI run must still exit (Android dials dvpnd directly)
}

export function networkMatches(v: Pick<DaemonVersion, 'programId' | 'mint'>): boolean {
  return v.programId === PROGRAM_ID.toBase58() && v.mint === MINT.toBase58();
}

function detach(): void {
  if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
  stopHeartbeat();
  if (client) {
    client.close();
    client = null;
  }
  info.reachable = false;
}

export function stopDaemonLink(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
  detach();
  if (bridge) {
    bridge.stdin?.end(); // bridge exits on stdin EOF
    const b = bridge;
    setTimeout(() => { if (b.exitCode === null) b.kill(); }, 1500);
  }
}

/** Re-probe now (after setup or a settings restart). */
export function relinkDaemon(): void {
  backoffMs = 2000;
  if (bridge) bridge.stdin?.end();
  else startDaemonLink();
}

// ─── Doctor (F1.6) ───
// dvpnd reports advisories as OK=true with a Detail (e.g. a protocol binary missing): that is a warning.
export interface DoctorCheck { name: string; ok: boolean; level: 'ok' | 'warn' | 'fail'; detail: string }
/** dvpnd's real advisories (OK=true + Detail): a protocol program or adapter missing, plan delegate. */
const ADVISORY = /^(service_|delegate$)/;

/** dvpnd dfe36c7 printed {Name, OK, Detail}; cf4c372 prints {name, ok, detail}. Accept both. */
export function parseDoctorRows(json: string, opts: { android?: boolean } = {}): DoctorCheck[] {
  const android = opts.android ?? isAndroid();
  const rows = JSON.parse(json) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const ok = (r.ok ?? r.OK) === true;
    const name = String(r.name ?? r.Name ?? '?');
    // cb33 adds severity (ok / warning / error; ok is false exactly for error): a warning row is ok but a warning.
    const sev = String(r.severity ?? '');
    let detail = String(r.detail ?? r.Detail ?? '');
    // Android: WireGuard and AmneziaWG run inside dvpnd on the phone's VPN interface, so dvpnd's
    // Linux checks for wg / awg programs and the amneziawg module do not apply (D-A2).
    if (android && ok && /^service_(binaries|userspace)_(wireguard|amneziawg)$/.test(name)) {
      return { name, ok, level: 'ok', detail: 'Built in on Android (runs inside the VPN engine).' };
    }
    // dvpnd prints a raw `dvpnctl grant open-grant …` command here; say it in the app's words (idea from the Linux app).
    if ((name === 'grant' || name === 'mandate') && !ok) detail = 'This device has no spending permission yet. Set it up: Wallet → Update device setup, or devnet-dvpn device setup --yes.';
    // The kill-switch row is OK with a status note; "nothing held" is the normal state, not a warning
    // (owner's laptop 2026-10-22 showed it as "!").
    if (name === 'kill_switch' && ok) {
      if (/no persisted kill switch/i.test(detail)) detail = 'Nothing held: internet is not blocked.';
      // cb33 says it itself (severity); older builds only in the text
      const warn = sev ? sev === 'warning' : /unpinned|unusable|leftover/i.test(detail);
      return { name, ok, level: warn ? 'warn' : 'ok', detail };
    }
    return { name, ok, level: !ok ? 'fail' : sev === 'warning' || (detail && ADVISORY.test(name)) ? 'warn' : 'ok', detail };
  });
}

export function runDoctor(home = deviceRecord()?.home ?? DEFAULT_DAEMON_HOME): Promise<DoctorCheck[]> {
  return new Promise((resolve) => {
    const exe = dvpndPath();
    if (!fs.existsSync(exe)) { resolve([{ name: 'binary', ok: false, level: 'fail', detail: `${path.basename(exe)} is not installed with this app.` }]); return; }
    execFile(exe, doctorArgs(home), { timeout: 60_000, windowsHide: true, env: withProtocolPath() }, (err, stdout, stderr) => {
      const text = String(stdout);
      const start = text.indexOf('[');
      if (start >= 0) {
        try {
          resolve(parseDoctorRows(text.slice(start)));
          return;
        } catch (parseErr) {
          log.warn('doctor output not JSON', { err: (parseErr as Error).message });
        }
      }
      resolve([{ name: 'doctor', ok: false, level: 'fail', detail: (err?.message ?? String(stderr)).slice(0, 300) }]);
    });
  });
}

// ─── First-run setup (F1.5) ───
// dvpnd will not start until its device key holds a grant, so setup is:
//   1. initDevice   — `dvpnd init` UNELEVATED into <data>/daemon-staging → device address
//   2. (owner signs device setup: delegate + grant + SOL — services/wallet.deviceSetup)
//   3. installService — ONE UAC prompt: copy into ProgramData, lock keys, install + start
export function stagingHome(): string {
  return path.join(getHost().dataDir, 'daemon-staging');
}

type InitResult = { ok: boolean; device?: string; error?: string; reused?: boolean };

/**
 * fleet-bugs W3: a wallet switch installs this fresh home in place of the old one (setup-daemon.ps1
 * W1), so copy the user's settings (kill switch, DNS, LAN, split, RPC, payment limits, whole-device)
 * from the installed home into it first. Nothing installed yet, or unreadable: dvpnd defaults stay.
 */
export function carryLiveSettings(staging: string, live = DEFAULT_DAEMON_HOME): void {
  const rootOld = path.join(live, 'config.toml');
  const clientOld = path.join(live, 'client', 'config.toml');
  if (!fs.existsSync(rootOld) || !fs.existsSync(clientOld)) return;
  try {
    const rootNew = path.join(staging, 'config.toml');
    const clientNew = path.join(staging, 'client', 'config.toml');
    const out = carrySettings(
      { root: fs.readFileSync(rootOld, 'utf8'), client: fs.readFileSync(clientOld, 'utf8') },
      { root: fs.readFileSync(rootNew, 'utf8'), client: fs.readFileSync(clientNew, 'utf8') },
    );
    fs.writeFileSync(rootNew, out.root, 'utf8');
    fs.writeFileSync(clientNew, out.client, 'utf8');
    for (const s of TUN_SERVICES) {
      const from = path.join(live, 'client', s, 'config.toml');
      const into = path.join(staging, 'client', s, 'config.toml');
      if (!fs.existsSync(from) || !fs.existsSync(into)) continue;
      const tun = readToml(fs.readFileSync(from, 'utf8'), '', 'tun');
      if (typeof tun === 'boolean') fs.writeFileSync(into, renderServiceConfig(fs.readFileSync(into, 'utf8'), tun), 'utf8');
    }
    log.info('settings carried to the new device home', { from: live });
  } catch (err) {
    log.warn('could not carry settings to the new device home; dvpnd defaults stay', { error: (err as Error).message });
  }
}

export function initDevice(owner: string): Promise<InitResult> {
  const existing = deviceRecord();
  if (existing && existing.owner === owner) return Promise.resolve({ ok: true, device: existing.device, reused: true });
  const exe = dvpndPath();
  if (!fs.existsSync(exe)) return Promise.resolve({ ok: false, error: 'The VPN service is missing from this install. Reinstall the app.' });
  if (isAndroid()) return initAndroidDevice(exe, owner);
  const staging = stagingHome();
  if (fs.existsSync(path.join(staging, 'config.toml'))) {
    return Promise.resolve({ ok: false, error: 'A half-finished setup exists. Remove it from Settings → Advanced and start again.' });
  }
  return new Promise((resolve) => {
    execFile(exe, ['init', '--home', staging, '--role', 'client', '--owner', owner, '--plain-key', '--socket-group', 'Users'], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout);
      const at = text.indexOf('{');
      if (err || at < 0) { resolve({ ok: false, error: `Could not set up the VPN service. Try again, or send the log from Diagnostics (${(err?.message ?? String(stderr)).slice(0, 300)}).` }); return; }
      try {
        const init = JSON.parse(text.slice(at)) as { public_key: string };
        writeJson(DEVICE_FILE, { device: init.public_key, home: DEFAULT_DAEMON_HOME, owner, at: Date.now() } satisfies DeviceRecord);
        log.info('device initialised', { device: init.public_key });
        carryLiveSettings(staging);
        resolve({ ok: true, device: init.public_key });
      } catch (parseErr) {
        resolve({ ok: false, error: `Could not set up the VPN service. Try again, or send the log from Diagnostics (unreadable output: ${(parseErr as Error).message}).` });
      }
    });
  });
}

/** L6: poll (bounded) until `probe` is true; probes and sleep are injectable (exported for tests). */
export async function pollUntil(
  probe: () => Promise<boolean>,
  waitMs = 30_000,
  stepMs = 2_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let waited = 0; ; waited += stepMs) {
    if (await probe()) return true;
    if (waited + stepMs > waitMs) return false;
    await sleep(stepMs);
  }
}

function serviceRunning(service: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('sc.exe', ['query', service], { timeout: 10_000, windowsHide: true }, (_err, stdout) => resolve(/STATE\s*:\s*4\s+RUNNING/.test(String(stdout))));
  });
}

/** After the install step ran past its time limit (and its grace): did the service come up anyway? */
async function verifyInstalled(): Promise<ElevatedResult> {
  if (await pollUntil(() => serviceRunning('dvpnd'))) {
    log.info('install step timed out but the service is running', { service: 'dvpnd' });
    return { status: 'ok', detail: 'service installed and running (the administrator step took longer than expected)' };
  }
  return { status: 'error', detail: 'The administrator step took too long and the VPN service is not running. Try again; if it keeps happening, send the log from Diagnostics.' };
}

/** Elevated: move the staged home into ProgramData and run it as the dvpnd service. Call after device setup. */
export async function installService(): Promise<{ ok: boolean; error?: string }> {
  const rec = deviceRecord();
  if (!rec) return { ok: false, error: 'Initialise the device first.' };
  if (isAndroid()) return restartAndroidDaemon();
  const r = await runElevated(scriptPath('setup-daemon.ps1'), { Dvpnd: dvpndPath(), Staging: stagingHome(), DaemonHome: rec.home, BinRoot: path.dirname(binPath('x')) }, undefined, verifyInstalled);
  relinkDaemon();
  return r.status === 'ok' ? { ok: true } : { ok: false, error: r.detail };
}

/**
 * Start the installed service if it is stopped, without elevation (service-user-start.ps1 gives
 * interactive users the start right). dvpnd refuses to start until the device has a grant, so
 * after device setup on an upgraded or new install the service is usually stopped.
 * 'no-right' = an older install without that right: the caller says to use Diagnostics.
 */
export function startServiceIfStopped(service = 'dvpnd'): Promise<'running' | 'started' | 'no-service' | 'no-right' | 'failed'> {
  if (isAndroid()) return restartAndroidDaemon().then((r) => (r.ok ? 'started' : 'failed'));
  // Off Windows there is no sc.exe query: we can't tell "not installed" from "stopped", so never
  // claim the service is missing (that copy says to reinstall). Ports query systemd/launchd here.
  if (process.platform !== 'win32') return Promise.resolve('failed');
  const sc = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile('sc.exe', args, { timeout: 20_000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? Number((err as NodeJS.ErrnoException & { code?: unknown }).code) || 1 : 0, out: String(stdout) });
    });
  });
  return (async () => {
    const q = await sc(['query', service]);
    if (/FAILED 1060/.test(q.out)) return 'no-service';
    if (/STATE\s*:\s*4\s+RUNNING/.test(q.out)) return 'running';
    const s = await sc(['start', service]);
    if (s.code === 0 || /FAILED 1056/.test(s.out)) { relinkDaemon(); return 'started'; }  // 1056 = already running
    if (/FAILED 5:/.test(s.out)) return 'no-right';
    log.warn('service start failed', { out: s.out.slice(0, 300) });
    return 'failed';
  })();
}

/** Read the device public key of an existing home (`dvpnd key list`). Fails when its key folder is admin-only. */
export function detectDevice(home = DEFAULT_DAEMON_HOME): Promise<{ ok: boolean; device?: string; error?: string }> {
  const exe = dvpndPath();
  if (!fs.existsSync(exe)) return Promise.resolve({ ok: false, error: 'The VPN service is missing from this install. Reinstall the app.' });
  return new Promise((resolve) => {
    execFile(exe, keyListArgs(home), { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      const text = String(stdout);
      const at = text.indexOf('[');
      if (err || at < 0) { resolve({ ok: false, error: `Could not read the service's device key (${(err?.message ?? String(stderr)).trim().slice(0, 160)}). Enter its address instead.` }); return; }
      try {
        const keys = JSON.parse(text.slice(at)) as Array<{ name: string; public_key: string }>;
        const dev = operatorKey(keys);
        resolve(dev ? { ok: true, device: dev.public_key } : { ok: false, error: 'The service home has no device key.' });
      } catch (parseErr) {
        resolve({ ok: false, error: `Could not read the service's device key (unreadable output: ${(parseErr as Error).message}). Enter its address instead.` });
      }
    });
  });
}

/** Record an already-initialised daemon's device key (e.g. service set up by an admin). */
export function registerDevice(device: string, owner: string, home = DEFAULT_DAEMON_HOME): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(device)) throw new Error('The device must be a Solana address (base58).');
  writeJson(DEVICE_FILE, { device, home, owner, at: Date.now() } satisfies DeviceRecord);
}

// ─── Android (D-A1): dvpnd is the app's own process, supervised by the VPN service ───
// No staging and no elevation: init writes the real home in the app's files, and the app
// restarts dvpnd through the app bridge.

/** Ask the app to restart dvpnd (new config or a fresh grant), then re-attach. */
export async function restartAndroidDaemon(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await bridgeCall({ op: 'daemonRestart' });
    if (!r.ok) return { ok: false, error: r.error ?? 'The app could not restart its VPN engine.' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  await new Promise((res) => setTimeout(res, 2500));
  relinkDaemon();
  await daemonReady(15_000);
  // The first re-attach can land before the new dvpnd listens (it fails, the link retries with
  // backoff 2/4/8 s, scheduleReattach): wait until it answers, or `daemon set` said "restarted"
  // and the next connect got "The VPN service is not running" (grid F16.5 on API 35).
  // dvpnd only answers after resolving pending channels, one RPC read each; behind public devnet
  // 429s that took 46 s once (edge laninbound, API 35), so give it a minute.
  const until = Date.now() + 60_000;
  while (!info.reachable && Date.now() < until) await new Promise((res) => setTimeout(res, 500));
  if (!info.reachable) return { ok: false, error: info.error ?? 'The VPN engine did not come back after the restart.' };
  return { ok: true };
}

/** The wallet an Android engine home acts for (`owner = '…'` in its config.toml), or '' when unreadable. */
export function androidHomeOwner(cfg: string): string {
  try {
    return /^\s*owner\s*=\s*['"]([^'"]+)['"]/m.exec(fs.readFileSync(cfg, 'utf8'))?.[1] ?? '';
  } catch (err) {
    log.warn('engine config unreadable', { cfg, err: (err as Error).message });
    return '';
  }
}

/**
 * The wallet an engine home acts for. dvpnd writes the owner into the role folder
 * (`<home>/client/config.toml` on the phone); `<home>/config.toml` holds no owner. Reading only the
 * top file returned '' and every wallet switch reused the old wallet's home and key (fleet W1, rc1).
 */
export function homeOwner(home: string): string {
  for (const cfg of [path.join(home, 'client', 'config.toml'), path.join(home, 'config.toml')]) {
    if (!fs.existsSync(cfg)) continue;
    const owner = androidHomeOwner(cfg);
    if (owner) return owner;
  }
  return '';
}

/** True when the home has an engine config at all (either layout). */
function homeExists(home: string): boolean {
  return fs.existsSync(path.join(home, 'client', 'config.toml')) || fs.existsSync(path.join(home, 'config.toml'));
}

/** The newest `<home>.prev-*` kept for this wallet by an earlier wallet switch, or '' if none. */
export function keptHomeFor(home: string, owner: string): string {
  try {
    const dir = path.dirname(home);
    const base = `${path.basename(home)}.prev-`;
    const found = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort().reverse()
      .map((n) => path.join(dir, n))
      .find((p) => homeOwner(p) === owner);
    return found ?? '';
  } catch (err) {
    log.warn('listing kept engine homes failed', { home, err: (err as Error).message });
    return '';
  }
}

/**
 * cb33 move (once): a phone set up before cb33 has files/dvpnd/client (config.toml +
 * client/config.toml, key client/keys/device.json). Its key goes to <home>/keys/operator.json (same
 * file format), so `init` reuses it and the device keeps its grant and deposits; its settings follow
 * after init. The old home is renamed, never deleted (its key can still settle old deposits).
 * Returns the renamed old home to carry settings from, or '' when there is nothing to move.
 */
export function migrateAndroidHome(home: string, owner: string, legacy = process.env.DVPN_DAEMON_LEGACY_HOME ?? ''): string {
  if (!legacy || fs.existsSync(path.join(home, CONFIG_FILE))) return '';
  const oldKey = path.join(legacy, 'client', KEYS_DIR, `${LEGACY_DEVICE_KEY}.json`);
  if (!fs.existsSync(oldKey)) return '';
  // Another wallet's home keeps its key (fleet W1): it stays where it is, untouched.
  const oldOwner = homeOwner(legacy);
  if (oldOwner && oldOwner !== owner) return '';
  const keys = path.join(home, KEYS_DIR);
  const newKey = path.join(keys, `${OPERATOR_KEY}.json`);
  try {
    // cb33 modes: home 0750 (prepareInstanceDir), folders inside 0700, files 0600.
    fs.mkdirSync(home, { recursive: true, mode: 0o750 });
    fs.chmodSync(home, 0o750);
    fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
    fs.chmodSync(keys, 0o700);
    if (!fs.existsSync(newKey)) fs.copyFileSync(oldKey, newKey, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(newKey, 0o600);
    const kept = `${legacy}.pre-cb33`;
    fs.renameSync(legacy, kept);
    log.info('engine home moved to the cb33 layout', { from: legacy, home });
    return kept;
  } catch (err) {
    log.warn('moving the old engine home failed; a new key will be made', { legacy, err: (err as Error).message });
    return '';
  }
}

/** Settings from an old home (either layout) into a cb33 home's one config.toml. */
function carryIntoCb33(home: string, from: string): void {
  const into = path.join(home, CONFIG_FILE);
  const rootOld = path.join(from, CONFIG_FILE);
  const clientOld = path.join(from, 'client', CONFIG_FILE);
  try {
    const root = fs.readFileSync(rootOld, 'utf8');
    const client = fs.existsSync(clientOld) ? fs.readFileSync(clientOld, 'utf8') : root;
    fs.writeFileSync(into, carrySettingsInto({ root, client }, fs.readFileSync(into, 'utf8')), { encoding: 'utf8', mode: 0o600 });
    log.info('settings carried to the new device home', { from });
  } catch (err) {
    log.warn('could not carry settings to the new device home; dvpnd defaults stay', { from, error: (err as Error).message });
  }
}

function initAndroidDevice(exe: string, owner: string): Promise<InitResult> {
  const home = DEFAULT_DAEMON_HOME;
  // W3: the home kept by a wallet switch (or the pre-cb33 home); its settings go into the fresh one
  let carryFrom = migrateAndroidHome(home, owner);
  if (homeExists(home)) {
    const prevOwner = homeOwner(home);
    if (!prevOwner || prevOwner === owner) {
      // A home from an earlier install of the same app data and wallet: reuse its device key.
      return detectDevice(home).then((d) => {
        if (d.ok && d.device) registerDevice(d.device, owner, home);
        return { ...d, reused: d.ok };
      });
    }
    // Wallet switch (fleet W1): the engine home acts for the OLD wallet. Keep it (its key can still
    // settle that wallet's deposits) and make a fresh home for the new wallet; device setup then
    // restarts dvpnd on it.
    const prev = `${home}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(home, prev);
      carryFrom = prev;
      log.info('wallet switch: old engine home kept', { prev, oldOwner: prevOwner, owner });
    } catch (err) {
      return Promise.resolve({ ok: false, error: `Could not set up this phone for the new wallet (${(err as Error).message}). Restart the app and try again.` });
    }
  }
  // Back to a wallet this phone used before: restore its kept home (same device key, its grant and
  // deposits stay usable) instead of making another key.
  const kept = keptHomeFor(home, owner);
  if (kept) {
    try {
      fs.renameSync(kept, home);
      log.info('wallet switch: kept engine home restored', { kept, owner });
      return detectDevice(home).then((d) => {
        if (d.ok && d.device) registerDevice(d.device, owner, home);
        return { ...d, reused: d.ok };
      });
    } catch (err) {
      log.warn('restoring a kept engine home failed; making a new key', { kept, err: (err as Error).message });
    }
  }
  return runAndroidInit(exe, home, owner).then((r) => {
    if (!r.ok || !r.device) return r;
    writeJson(DEVICE_FILE, { device: r.device, home, owner, at: Date.now() } satisfies DeviceRecord);
    log.info('device initialised', { device: r.device });
    if (carryFrom) carryIntoCb33(home, carryFrom);
    return r;
  });
}

/** `sentinel-dvpnd init --instance c0 --home <home>`: the key's public key (an existing key in <home>/keys is reused). */
function runAndroidInit(exe: string, home: string, owner: string): Promise<InitResult> {
  return new Promise((resolve) => {
    execFile(exe, initArgs(home, owner), { timeout: 60_000 }, (err, stdout, stderr) => {
      const text = String(stdout);
      const at = text.indexOf('{');
      if (err || at < 0) { resolve({ ok: false, error: `Could not create this phone's VPN key (${(err?.message ?? String(stderr)).trim().slice(0, 160)}). Restart the app and try device setup again.` }); return; }
      try {
        const init = JSON.parse(text.slice(at)) as { public_key: string };
        resolve({ ok: true, device: init.public_key });
      } catch (parseErr) {
        resolve({ ok: false, error: `Could not create this phone's VPN key (unreadable output: ${(parseErr as Error).message}). Restart the app and try device setup again.` });
      }
    });
  });
}

/**
 * Android, at every start before the daemon link: a phone set up before cb33 has a device record
 * pointing at files/dvpnd/client and no cb33 home, so dvpnd would wait forever (device setup never
 * runs again). Move the key, init the c0 home on it (same public key, so its grant and deposits stay),
 * carry the settings and point the record at the new home. 'none' = nothing to do.
 */
export async function upgradeAndroidHomeOnStart(): Promise<'none' | 'moved' | 'failed'> {
  if (!isAndroid()) return 'none';
  const rec = deviceRecord();
  const home = DEFAULT_DAEMON_HOME;
  if (!rec?.owner) return 'none';
  if (fs.existsSync(path.join(home, CONFIG_FILE))) {
    if (rec.home !== home && homeOwner(home) === rec.owner) writeJson(DEVICE_FILE, { ...rec, home } satisfies DeviceRecord);
    return 'none';
  }
  const from = migrateAndroidHome(home, rec.owner);
  if (!from) return 'none';
  const r = await runAndroidInit(dvpndPath(), home, rec.owner);
  if (!r.ok || !r.device) {
    log.warn('cb33 home init after the move failed', { err: r.error });
    return 'failed';
  }
  if (r.device !== rec.device) {
    // Never silently swap the device key: the old one holds the grant and the deposits.
    log.error('cb33 home init made a different key than the recorded device', { recorded: rec.device, got: r.device });
    return 'failed';
  }
  carryIntoCb33(home, from);
  writeJson(DEVICE_FILE, { ...rec, home, at: Date.now() } satisfies DeviceRecord);
  log.info('engine home upgraded to cb33 on start', { device: r.device, home });
  return 'moved';
}
