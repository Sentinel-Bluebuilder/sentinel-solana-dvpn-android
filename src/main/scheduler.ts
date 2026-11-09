// ─── Root scheduler (F5, D9) — the only place timers live ───
// Live session data comes from the WatchSession stream (services/connection).
// Everything else is polled here; non-session polls pause while hidden.
import { getRpcState } from '../core/chain/rpc';
import { isAndroid } from './platform/android-bridge';
import { refreshWallet } from './services/wallet';
import { refreshNodes, nodesAge, findNode } from './services/nodes';
import { sessionsKnown, adoptRunningSession, outsideCheckShown, reconcileShownSession } from './services/connection';
import { readSettlements } from './services/settlement';
import { refreshSubscriptions, refreshPlans } from './services/plans';
import { daemonInfo, onDaemonChange } from './daemon/manager';
import { patch, snapshot, setIpChecksOff } from './app-state';
import { loadHomeIp, saveHomeIp } from './home-ip';
import { log } from './logger';
import { publicIp } from '../core/quality/quality';
import { getSettings } from './system/settings';
import { getDaemonSettings } from './daemon/settings';
import { dnsLabel } from '../core/daemon/dns-presets';
import { DEFAULT_POLL, type PollJob } from '../shared/poll';

/** The job's cadence from settings (read live, so a change applies on the next tick). */
export function pollMs(name: PollJob): number {
  return (getSettings().poll?.[name] ?? DEFAULT_POLL[name]) * 1000;
}
const IP_LOOK_MS = 5000;
const OUTSIDE_LOOK_MS = 2000;
/** The IPv4 literal in a node's https://host:port uri, or null for a name. */
export function hostOf(uri: string): string | null {
  const m = /^https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/.exec(uri);
  return m ? m[1] : null;
}
/** Hidden in the tray, refunds still get settled, just less often (each read is a program scan). */
export const HIDDEN_MIN_MS = 15 * 60_000;
/** No deposits and no session: nothing can come due, so the deposit scan slows down. */
export const IDLE_SETTLE_MIN_MS = 10 * 60_000;
/** A job returns this when it looked and had nothing to do: not reported as a run. */
const SKIPPED = Symbol('skipped');
function everyMs(j: Job): number {
  if (j.name === 'ip') return IP_LOOK_MS;
  let ms = pollMs(j.name);
  const s = snapshot();
  if (j.name === 'settlements' && !s.session && (s.settlements?.length ?? 0) === 0) ms = Math.max(ms, IDLE_SETTLE_MIN_MS);
  if (hidden && j.whenHidden) ms = Math.max(ms, HIDDEN_MIN_MS);
  // No session shown: look every 2 s at most, so a connect started elsewhere shows its tunnel
  // check ("Checking the connection…", up to ~9 s) instead of being found only once live (Q0357).
  if (j.name === 'session' && !s.session) ms = Math.min(ms, OUTSIDE_LOOK_MS);
  return ms;
}

export interface JobRun { name: PollJob; at: number; ms: number; ok: boolean; error?: string }
const runListeners = new Set<(r: JobRun) => void>();
/** Every finished job run (CLI "poll watch", tests). Returns an unsubscribe. */
export function onJobRun(fn: (r: JobRun) => void): () => void {
  runListeners.add(fn);
  return () => runListeners.delete(fn);
}

let ipForSession: string | null | undefined;
let lastVpnIp: string | null = null; // never taken as the user's own IP (routes settle after a disconnect)
let ipSettleCheck: string | null = null; // session still owed its 10-second re-check

interface Job { name: PollJob; whenHidden: boolean; run: () => Promise<unknown>; last: number; busy: boolean }

const jobs: Job[] = [
  { name: 'wallet', whenHidden: false, run: refreshWallet, last: 0, busy: false },
  { name: 'nodes', whenHidden: false, run: () => refreshNodes(), last: 0, busy: false },
  { name: 'plans', whenHidden: false, run: refreshPlans, last: 0, busy: false },
  { name: 'subscriptions', whenHidden: false, run: refreshSubscriptions, last: 0, busy: false },
  { name: 'settlements', whenHidden: true, run: readSettlements, last: 0, busy: false },
  {
    // F5.9: public IP every poll.ip s while connected (and right after a session changes), once when idle.
    // The job itself is looked at every 5 s; it decides whether a check is due.
    name: 'ip', whenHidden: false, last: 0, busy: false,
    run: async () => {
      const off = !getSettings().thirdPartyChecks;
      setIpChecksOff(off);
      if (off) { if (snapshot().publicIp) patch({ publicIp: null }); return SKIPPED; }
      loadHomeIp();
      const s = snapshot();
      const sid = s.session?.id ?? null;
      const age = s.publicIp ? Date.now() - s.publicIp.at : Infinity;
      // Re-check 10 s into a session too: routes may still be settling at the first check.
      const settling = sid !== null && ipSettleCheck === sid && age >= 10_000;
      if (!settling && sid === ipForSession && (sid ? age < pollMs('ip') : s.publicIp !== null)) return SKIPPED;
      ipSettleCheck = settling ? null : sid;
      ipForSession = sid;
      // Proxy (V2Ray/Xray) sessions leave system traffic direct: measure the VPN exit
      // through the session's SOCKS endpoint, which is the IP sites see for proxied apps.
      // Android: every app is inside the tunnel (tun2socks); the probe socket measures it (D-A4).
      const socks = isAndroid() ? undefined : s.session?.proxyEndpoint || undefined;
      // Q0387: with a session shown, Android measures only through the tunnel; mid-redial that is no
      // answer ("checking…"), never the phone's own IP labelled "Sites see".
      const r = await publicIp(6000, socks, { tunnelOnly: isAndroid() && sid !== null });
      // Also the direct exit for proxy sessions: apps that ignore the proxy leave by that IP.
      const d = socks ? await publicIp(6000) : null;
      const directIp = d && 'ip' in d ? d.ip : null;
      // Not connected: this is the user's own IP, the reference for "is traffic really going
      // through the VPN" (core/session/coverage). Kept on disk for sessions adopted at start.
      if (sid && 'ip' in r && r.ip !== snapshot().homeIp) lastVpnIp = r.ip;
      // Only once the app knows no session is running: an app started during a tunnel must
      // not take the node's IP for the user's own (VM proof 2026-10-22, WireGuard adopt).
      if (!sid && 'ip' in r && r.ip !== lastVpnIp && sessionsKnown() && !snapshot().session) saveHomeIp(r.ip);
      const nodeIp = s.session ? hostOf(findNode(s.session.node)?.uri ?? '') : null;
      patch({ publicIp: 'ip' in r ? { ip: r.ip, source: r.source, at: Date.now(), viaProxy: !!socks, directIp, sid, nodeIp } : null });
    },
  },
  {
    // A proxy session never touches Windows DNS, nor does a daemon set to dns = 'none'.
    name: 'dns', whenHidden: false, last: 0, busy: false, // two small file reads
    run: async () => {
      const d = getDaemonSettings().settings;
      patch({ dns: snapshot().session?.proxyEndpoint || d.dnsMode === 'none' ? 'System' : dnsLabel(d.dnsServers) });
    },
  },
  {
    // A session started elsewhere (the CLI, another window) while the app is open: without this
    // the screen kept "Connect" until the app restarted (Android grid A5). Only while the app is
    // idle — never during its own connect/disconnect — and one local daemon call; a session the
    // app already shows is followed by its own stream instead.
    name: 'session', whenHidden: false, last: 0, busy: false,
    run: async () => {
      const s = snapshot();
      // Q0361: a shown session is checked against dvpnd's list (its stream can miss the end).
      if (s.session) return daemonInfo().reachable && await reconcileShownSession() ? undefined : SKIPPED;
      // An outside connect being checked is followed by this poll too (no session to stream yet).
      if (!daemonInfo().reachable || (s.conn.phase !== 'idle' && s.conn.phase !== 'error' && !outsideCheckShown())) return SKIPPED;
      // startedElsewhere: its deposit stays open when it ends, as the CLI intends (grid F9.2 reuse).
      await adoptRunningSession({ applyProxy: !isAndroid(), startedElsewhere: true });
    },
  },
  {
    name: 'rpc', whenHidden: false, last: 0, busy: false,
    run: async () => {
      const s = await getRpcState();
      patch({ rpc: { serving: s.serving ?? null, healthy: s.slot !== null, publicOnly: !!s.publicOnly } });
    },
  },
];

const TICK_MS = 1000; // fine enough for the shortest cadence; each job keeps its own
let timer: NodeJS.Timeout | null = null;
let hidden = false;

/** A session started (new id): its deposit belongs in the list now, not at the next poll (Q0339). */
export function newSessionStarted(prev: string | null, next: string | null): boolean {
  return next !== null && next !== prev;
}
let settleForSession: string | null = null;

async function tick(): Promise<void> {
  const now = Date.now();
  // Q0339: connect, then open Activity: the new deposit (and its Top up) was missing for up to 60 s.
  const sid = snapshot().session?.id ?? null;
  if (newSessionStarted(settleForSession, sid)) { const s = jobs.find((x) => x.name === 'settlements'); if (s) s.last = 0; }
  settleForSession = sid;
  for (const j of jobs) {
    const every = everyMs(j);
    if (j.busy || now - j.last < every || (hidden && !j.whenHidden)) continue;
    if (j.name === 'nodes' && nodesAge() < every) { j.last = now; continue; }
    j.busy = true;
    j.last = now;
    const started = Date.now();
    let error: string | undefined;
    let skipped = false;
    j.run()
      .then((v) => { skipped = v === SKIPPED; })
      .catch((err) => { error = (err as Error).message; log.warn(`scheduler: ${j.name} failed`, { err: error }); })
      .finally(() => {
        j.busy = false;
        if (skipped) return;
        const r: JobRun = { name: j.name, at: started, ms: Date.now() - started, ok: error === undefined, ...(error ? { error } : {}) };
        for (const fn of runListeners) fn(r);
      });
  }
}

export function startScheduler(): void {
  if (timer) return;
  onDaemonChange(() => patch({ daemon: daemonInfo() }));
  patch({ daemon: daemonInfo() });
  timer = setInterval(() => void tick(), TICK_MS);
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function setHidden(h: boolean): void {
  hidden = h;
}

/** Run named jobs now (after a transaction, on login). */
export function refreshNow(...names: string[]): void {
  for (const j of jobs) if (!names.length || names.includes(j.name)) j.last = 0;
  void tick();
  void snapshot;
}

/** Each job, its cadence now and whether it keeps running while the window is hidden. */
export function jobInfo(): Array<{ name: PollJob; everyMs: number; whenHidden: boolean; last: number }> {
  return jobs.map((j) => ({ name: j.name, everyMs: pollMs(j.name), whenHidden: j.whenHidden, last: j.last }));
}

/** Run one job now and wait for it (CLI "poll run"). */
export async function runJobNow(name: PollJob): Promise<JobRun> {
  const j = jobs.find((x) => x.name === name);
  if (!j) throw new Error(`No background job "${name}" (the session poll runs only during a session).`);
  const started = Date.now();
  try {
    await j.run();
    j.last = started;
    return { name, at: started, ms: Date.now() - started, ok: true };
  } catch (err) {
    return { name, at: started, ms: Date.now() - started, ok: false, error: (err as Error).message };
  }
}
