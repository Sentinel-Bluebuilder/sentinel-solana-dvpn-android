// ─── Android main process (D-A3) ───
// The Kotlin shell starts this bundle (out/android/main.cjs) with Node 22 and talks to it over
// stdin/stdout, one JSON object per line. No network port: other apps on the phone can reach
// 127.0.0.1, they cannot reach this process's pipes.
//   in   {"id":7,"ch":"wallet:show","p":{...}}       a renderer invoke (window.api.invoke)
//   out  {"id":7,"r":{...}}                           its Result
//   out  {"ev":"state","p":{...}}                     a pushed event (window.api.on)
//   out  {"ready":true}                               handlers registered, accepting calls
// Logs go to the app log file and stderr, never stdout.
import { initRuntime } from '../main/runtime';
import { attachGlobalHandlers, log, routeConsoleToLog } from '../main/logger';
import { registerIpc } from '../main/ipc';
import { startDaemonLink, stopDaemonLink, onDaemonChange, daemonInfo, upgradeAndroidHomeOnStart } from '../main/daemon/manager';
import { upgradeSavedDnsAndroid } from '../main/daemon/settings';
import { snapshot } from '../main/app-state';
import '../main/ks-title-wire';
import { androidHeldBlock } from '../main/platform/android-bridge';
import { startScheduler, stopScheduler, setHidden } from '../main/scheduler';
import { adoptRunningSession, checkLeftoverBlock } from '../main/services/connection';
import { maybeAutoConnect } from '../main/services/auto-connect';
import { cliKeyStore } from '../cli/keystore';
import { EVENTS, TIERS } from '../shared/ipc';
import { notifyIfHidden } from '../main/system/notify';
import { handlers } from './electron-shim';

const dataDir = process.env.DVPN_DATA_DIR;
const resourcesDir = process.env.DVPN_RESOURCES;
if (!dataDir || !resourcesDir) {
  process.stderr.write('DVPN_DATA_DIR and DVPN_RESOURCES must be set by the Android app\n');
  process.exit(2);
}

// The app tells us when its screen is shown or hidden ({ visible }). Event notifications (dropped
// connection, refunds, low balance) go out only while it is hidden, as on desktop (C20): on desktop
// notifyIfHidden checks the window; here there is none, so the flag gates it.
let appVisible = true;

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

attachGlobalHandlers();
routeConsoleToLog();
initRuntime({
  name: 'app',
  resourcesDir,
  dataDir,
  // The same Keystore-sealed store as the in-app CLI: one wallet per phone (DVPN_KEYFILE in tests).
  keyStore: cliKeyStore(dataDir, process.env.DVPN_KEYFILE || undefined),
  emit: (channel, payload) => {
    send({ ev: channel, p: payload });
    if (channel === EVENTS.TOAST && !appVisible) notifyIfHidden(payload as { kind: string; message: string }, null);
  },
});
log.info('android main start', { version: process.env.DVPN_APP_VERSION, node: process.version });
registerIpc();

// ─── Renderer calls ───
const allowed = new Set(Object.keys(TIERS));

async function dispatch(id: unknown, ch: unknown, p: unknown): Promise<void> {
  if (typeof ch !== 'string' || !allowed.has(ch)) {
    send({ id, r: { ok: false, error: `blocked channel ${String(ch)}`, code: 'blocked' } }); // copy:internal
    return;
  }
  const fn = handlers.get(ch);
  if (!fn) {
    send({ id, r: { ok: false, error: `no handler for ${ch}`, code: 'internal' } }); // copy:internal
    return;
  }
  try {
    send({ id, r: await fn(null, p) });
  } catch (err) {
    log.error(`android ipc ${ch} failed`, err);
    send({ id, r: { ok: false, error: (err as Error).message || 'Something went wrong.', code: 'internal' } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: { id?: unknown; ch?: unknown; p?: unknown; visible?: unknown; quit?: unknown };
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log.warn('android main: unreadable line from the app', { err: (err as Error).message });
      continue;
    }
    if (typeof msg.visible === 'boolean') { appVisible = msg.visible; setHidden(!msg.visible); } // screen shown / hidden
    else if (msg.quit) void quit();
    else void dispatch(msg.id, msg.ch, msg.p);
  }
});

// ─── Services ───
// cb33: an older phone's engine home moves into files/sentinel-dvpn/c0 first (the daemon waits for it).
void upgradeAndroidHomeOnStart()
  .catch((err) => { log.warn('cb33 home upgrade failed', { err: (err as Error).message }); return 'failed' as const; })
  .then((r) => {
    if (r !== 'none') log.info('cb33 home upgrade', { result: r });
    startDaemonLink();
    // Only now: before startDaemonLink, daemonReady() resolves at once and auto-connect would run
    // against a daemon that is not there yet.
    startScheduler();
    void maybeAutoConnect();
  });
// After the daemon link settles: adopt its session, else look for a leftover block (F14.3).
// Q0365: an older preset's DNS list in dvpnd's file is upgraded once, only while nothing is connected
// or connecting (it restarts dvpnd).
let dnsUpgradeTried = false;
async function upgradeDnsOnce(): Promise<void> {
  if (dnsUpgradeTried || !daemonInfo().reachable || snapshot().session || snapshot().conn.phase !== 'idle') return;
  dnsUpgradeTried = true;
  try {
    // Never while the kill switch holds the interface (or its state is unknown): the restart
    // would touch the block.
    if ((await androidHeldBlock()) !== false) {
      log.info('saved DNS list upgrade skipped: the kill switch may be holding the interface');
      dnsUpgradeTried = false; // try again on the next daemon change
      return;
    }
    await upgradeSavedDnsAndroid();
  } catch (err) {
    log.warn('saved DNS list upgrade failed', { err: (err as Error).message });
  }
}
onDaemonChange(() => { void adoptRunningSession({ applyProxy: false }).then(upgradeDnsOnce).then(() => checkLeftoverBlock()); });
send({ ready: true });

// The app closing its end (process killed, app updated) or an explicit quit: stop cleanly.
let quitting = false;
async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  stopScheduler();
  // The VPN session lives in dvpnd and the VpnService: leaving the UI must never drop it.
  stopDaemonLink();
  process.exit(0);
}
process.stdin.on('end', () => { void quit(); });
