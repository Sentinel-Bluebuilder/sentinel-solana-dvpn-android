// ─── Connect / disconnect (F9, F11, F12) ───
// "Fail before paying": every zero-cost check runs before the daemon is asked to
// open a channel. The daemon then opens the channel with the device key, brings
// the tunnel up, signs vouchers every 60 s and reconnects on its own (D6).
// Never show "Disconnected" before StopSession returns (docs/29 §3).
import type { ConnectRequest, LiveSession, Result } from '../../shared/types';
import type { DaemonClient, DaemonSession, DaemonChannel, Credential } from '../../core/daemon/client';
import { stopLiveOrCurrent } from './stop-session';
import { waitForDaemon, SERVICE_WAIT_MS } from './daemon-wait';
import { prepayCost, preflight, reusableChannel, planLimitReached, heldTicket, nodeHasRoom } from './connect-checks';
import { ensureHomeIp } from '../home-ip';
import { outsideCheck, withCheckingWatch } from '../../core/session/checking-watch';
import type { Copy } from '../../core/session/state';
import { closeReasonCopy, connectErrorCopy, phaseFromDaemon, viewFor, TICKET_RETRY_DELAYS_MS, RPC_BUSY_DELAYS_MS, openedChannelOn429, newDepositAfter429, adoptedChannelMissing, ADOPT_LAG_DELAYS_MS } from '../../core/session/state';
import { discoverNode } from '../../core/nodes/discovery';
import { costPreview } from '../../core/pricing/cost';
import { MODE_STREAM, MODE_VOUCHER } from '../../core/chain/idl';
import { daemon, daemonInfo, restartAndroidDaemon, startServiceIfStopped } from '../daemon/manager';
import { ownerAddress } from '../wallet/vault';
import { patch, setRedialFollow, setSplitInEffect, snapshot, toast } from '../app-state';
import { recordStart, recordEnd } from './history';
import { claimForReuse, settleChannelSoon, settlesOnEnd } from './settlement';
import { clearSystemProxy, setSystemProxy } from '../system/proxy';
import { log } from '../logger';
import { getDaemonSettings, serviceUsesTun, splitForSession } from '../daemon/settings';
import { getSettings } from '../system/settings';
import { waitForDirect } from '../system/direct-wait';
import { publicIp } from '../../core/quality/quality';
import { DEFAULT_POLL } from '../../shared/poll';
import { internetReachable } from '../../core/quality/reachability';
import { getRpcUrls, onRpcRetry, resetRpcTransport } from '../../core/chain/rpc';
import { waitForDirectPath } from './net-settle';
import { getHost } from '../host';
import { cancelRequested, clearConnecting, markConnecting, otherConnect, requestCancel, waitConnectEnded } from './connect-marker';
import { dnsReallyLeftOver, flushDnsCache } from '../system/dns-check';
import { leftoverTunnels, removeTunnelServices, rivalVpns } from '../system/tunnels';
import { firstData } from './first-data';
import { androidHeldBlock, isAndroid } from '../platform/android-bridge';

let unwatch: (() => void) | null = null;

let pollTimer: NodeJS.Timeout | null = null;
let cancelled = false;

/** The shared data dir for the cross-process connect marker (DC1); null where no host is set (unit tests). */
let markerDirWarned = false;
function markerDir(): string | null {
  try {
    return getHost().dataDir;
  } catch (err) {
    if (!markerDirWarned) log.warn('connect marker: no data dir', { err: (err as Error).message });
    markerDirWarned = true;
    return null;
  }
}

/** Cancel pressed here, or a Disconnect run in another process asked this connect to stop (DC1). */
function isCancelled(): boolean {
  if (!cancelled) {
    const dir = markerDir();
    if (dir && cancelRequested(dir)) {
      log.info('connect: stop requested by another process');
      cancelled = true;
    }
  }
  return cancelled;
}

/**
 * DC1: a Disconnect while ANOTHER process is still connecting (a CLI connect paying its deposit) found
 * no session and answered "No active session.", then that connect finished. Ask it to stop, ask dvpnd
 * to stop the start it may be inside, and wait for it to end. Returns false when no connect was running.
 */
export async function stopOtherConnect(waitMs = 60_000): Promise<{ stopped: boolean; ended: boolean }> {
  const dir = markerDir();
  const other = dir ? otherConnect(dir) : null;
  if (!dir || !other) return { stopped: false, ended: true };
  log.info('disconnect: a connect is running in another process; asking it to stop', { pid: other.pid, node: other.node });
  requestCancel(dir, other);
  try {
    await daemon().stopSession('');
  } catch (err) {
    if ((err as { kind?: string }).kind !== 'not-found') log.warn('disconnect: could not ask the VPN service to stop connecting', { err: (err as Error).message });
  }
  const ended = await waitConnectEnded(dir, other, waitMs);
  if (!ended) log.warn('disconnect: the other connect did not end in time', { pid: other.pid, waitMs });
  return { stopped: true, ended };
}
/** Sessions picked up while the app was open but started elsewhere (the CLI): shown, never auto-settled. */
const foreign = new Set<string>();

// ─── Reconnect chains (DIR/QA 10-30): dvpnd's counters are per session, the user sees one ───
/** Totals of the sessions a reconnect chain replaced, keyed by the session that carries them on. */
const chainCarry = new Map<string, { rx: bigint; tx: bigint; spent: bigint; start?: number | null }>();
const big = (v: string | undefined): bigint => {
  try { return BigInt(v || '0'); } catch (err) { log.warn('unreadable session counter; counted as 0', { v, err: (err as Error).message }); return 0n; }
};

/** What the rows before `s` in its reconnect chain used, from dvpnd's own list (a CLI has no memory). */
export function chainTotals(list: DaemonSession[], s: DaemonSession): { rx: bigint; tx: bigint; spent: bigint } {
  const t = { rx: 0n, tx: 0n, spent: 0n };
  const seen = new Set([s.id]);
  for (let prev = s.replaces; prev && !seen.has(prev);) {
    seen.add(prev);
    const row = list.find((x) => x.id === prev);
    if (!row) break;
    t.rx += big(row.usage?.rxBytes); t.tx += big(row.usage?.txBytes); t.spent += big(row.spent);
    prev = row.replaces;
  }
  return t;
}

export function toLive(s: DaemonSession): LiveSession {
  const c = chainCarry.get(s.id);
  const chainStart = Number(s.chainStartedUnix || 0);
  return {
    id: s.id,
    node: s.node,
    status: s.status,
    service: s.service,
    rxBytes: c ? String(big(s.usage?.rxBytes) + c.rx) : s.usage?.rxBytes ?? '0',
    txBytes: c ? String(big(s.usage?.txBytes) + c.tx) : s.usage?.txBytes ?? '0',
    seconds: s.usage?.seconds ?? '0',
    spent: c ? String(big(s.spent) + c.spent) : s.spent ?? '0',
    channel: s.channel ?? '',
    proxyEndpoint: s.proxyEndpoint ?? '',
    error: s.error ?? '',
    warning: s.warning ?? '',
    // the chain's first start: one timer across a reconnect that came back as a new session
    startedAt: chainStart > 0 ? chainStart * 1000 : c?.start ? c.start : s.startedAt ? Number(s.startedAt.seconds) * 1000 : null,
  };
}

export const SERVICE_MISSING_COPY = 'The VPN service is not installed on this computer (reinstalling the app removes it). Set it up again: Wallet > Set up device, or run: devnet-dvpn daemon install --yes. Nothing was paid.';

function fail<T = never>(message: string, code = 'preflight', action: string | null = null, node = ''): Result<T> {
  patch({ conn: viewFor('error', message), lastConnectError: { code, message, action, node } });
  return { ok: false, error: message, code, action };
}

/** The user stopped the connect (Cancel, or Disconnect while connecting): not a failure. Home goes back
 *  to "Not connected" with the note and a "Connect again" button; nothing turns red. */
function stoppedByUser<T = never>(message: string, node: string): Result<T> {
  const action = 'Connect again';
  patch({ conn: viewFor('idle', message), lastConnectError: { code: 'cancelled', message, action, node }, lastCloseMessage: null });
  return { ok: false, error: message, code: 'cancelled', action };
}

async function startWithRetry(node: string, firstCred: Credential, isTicket: boolean, basis?: 'per_gb' | 'per_hour'): Promise<DaemonSession> {
  let cred = firstCred;
  const delays = isTicket ? [0, ...TICKET_RETRY_DELAYS_MS] : [0];
  // The public RPC rate-limits dvpnd (429) while it reads an existing deposit or ticket. Nothing
  // is paid before that read, so retrying is safe. A new deposit is retried only as that deposit.
  const reuse = !('newChannel' in cred);
  // Deposits that existed before this attempt: a 429 can then be told apart from a paid deposit.
  const channelsNow = async (): Promise<DaemonChannel[] | null> => {
    try { return await daemon().listChannels(); } catch (err) { log.warn('listing channels for a 429 check failed', { error: (err as Error).message }); return null; }
  };
  let before = reuse ? null : new Set((await channelsNow())?.map((c) => c.address) ?? []);
  let busy = 0;
  // A deposit carried on with after a 429; if the chain never shows it, it was not paid (see below).
  let adopted: string | null = null;
  let missing = 0;
  let repaid = false;
  let last: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (isCancelled()) throw new Error('cancelled'); // copy:internal
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      // dvpnd lists the session as "checking" during its tunnel check: show that step (Q0357).
      return await withCheckingWatch(daemon().startSession(node, cred, isTicket ? undefined : basis), {
        listSessions: () => daemon().listSessions(),
        onChecking: () => { if (!isCancelled()) patch({ conn: viewFor('checking') }); },
      });
    } catch (err) {
      last = err;
      const msg = (err as Error).message;
      if (adoptedChannelMissing(msg, adopted)) {
        // RPC lag first: ask again for the same deposit (paying again here could pay twice).
        if (missing < ADOPT_LAG_DELAYS_MS.length) {
          log.warn('carried-on deposit not on chain yet; asking again', { channel: adopted, delay: ADOPT_LAG_DELAYS_MS[missing] });
          delays.splice(i + 1, 0, ADOPT_LAG_DELAYS_MS[missing++]);
          continue;
        }
        // Still missing after the waits: its open never landed, nothing was paid. One new deposit.
        if (!repaid && 'newChannel' in firstCred) {
          log.warn('carried-on deposit never landed; paying a new deposit', { channel: adopted });
          repaid = true; adopted = null; cred = firstCred;
          before = new Set((await channelsNow())?.map((c) => c.address) ?? []);
          delays.splice(i + 1, 0, RPC_BUSY_DELAYS_MS[0]);
          continue;
        }
      }
      // dvpnd pays a new deposit, then re-reads it; a 429 on that read names the deposit that is
      // now open and paid. Carry on with that one (no second payment) instead of failing.
      const paid = !reuse ? openedChannelOn429(msg) : null;
      if (paid && busy < RPC_BUSY_DELAYS_MS.length) {
        log.warn('rpc busy after the deposit was paid; continuing with that deposit', { channel: paid, delay: RPC_BUSY_DELAYS_MS[busy] });
        cred = { channel: paid };
        adopted = paid;
        delays.splice(i + 1, 0, RPC_BUSY_DELAYS_MS[busy++]);
        continue;
      }
      if ((reuse || 'channel' in cred) && /429|Too Many Requests/i.test(msg) && busy < RPC_BUSY_DELAYS_MS.length) {
        log.warn('rpc busy while starting; retrying', { delay: RPC_BUSY_DELAYS_MS[busy] });
        delays.splice(i + 1, 0, RPC_BUSY_DELAYS_MS[busy++]);
        continue;
      }
      // New deposit, other 429 wording: retry only when dvpnd's own list proves nothing was paid.
      if ('newChannel' in cred && /429|Too Many Requests/i.test(msg) && busy < RPC_BUSY_DELAYS_MS.length) {
        const d = newDepositAfter429(node, before, await channelsNow());
        if (d.action !== 'unknown') {
          if (d.action === 'adopt') { cred = { channel: d.channel }; adopted = d.channel; }
          log.warn('rpc busy while starting a new deposit', { decision: d.action, delay: RPC_BUSY_DELAYS_MS[busy] });
          delays.splice(i + 1, 0, RPC_BUSY_DELAYS_MS[busy++]);
          continue;
        }
      }
      if (!isTicket || !/ticket_invalid|invalid_ticket/.test(msg)) throw err;
      log.warn('ticket_invalid, retrying', { delay: delays[i] });
    }
  }
  throw last;
}

export async function connect(req: ConnectRequest): Promise<Result<LiveSession>> {
  if (req.confirmed !== true) return { ok: false, error: 'Confirm the cost first.', code: 'not-confirmed' };
  const owner = ownerAddress();
  if (!owner) return fail('Set up a wallet first.', 'no-wallet', 'Open Wallet');
  // A settings change restarts the service; connecting waits for the link (daemon-wait.ts).
  if (!daemonInfo().reachable) {
    log.info('connect waits for the VPN service', { maxMs: SERVICE_WAIT_MS });
    patch({ conn: viewFor('preflight', 'Waiting for the VPN service to restart…'), lastCloseMessage: null, lastConnectError: null });
  }
  let d = await waitForDaemon(SERVICE_WAIT_MS, daemonInfo);
  if (!d.reachable) {
    // Not running vs not installed need different fixes. A reinstall removes the service and the
    // setup does not register it (the app does, at device setup): test-host kse-pk-215 said "not
    // running" for a service that did not exist. A stopped one is started (no elevation).
    const svc = await startServiceIfStopped();
    if (svc === 'no-service') return fail(SERVICE_MISSING_COPY, 'daemon-missing', 'Set up device');
    if (svc === 'started') d = await waitForDaemon(SERVICE_WAIT_MS, daemonInfo);
    if (!d.reachable) return fail('The VPN service is not running.', 'daemon-unavailable', 'Open diagnostics');
  }
  if (d.networkOk === false) return fail(d.error ?? 'The VPN service is on a different network.', 'network-mismatch');
  if (!d.device) return fail('Finish device setup first.', 'no-device', 'Open Wallet');
  cancelled = false;
  const markDir = markerDir();
  if (markDir) markConnecting(markDir, req.node);
  patch({ conn: viewFor('preflight', 'Checking the server and your balance…'), lastCloseMessage: null, lastConnectError: null });
  // G31: a chain read retrying (slow or unreachable RPC) says so instead of a silent "Checking…" for a minute.
  const stopRetryNote = onRpcRetry((e) => {
    const phase = snapshot().conn?.phase;
    if (phase !== 'preflight' && phase !== 'connecting' && phase !== 'paying') return;
    log.warn('chain read retrying during connect', { read: e.label, attempt: e.attempt, err: e.error, leftMs: e.leftMs });
    patch({ conn: viewFor(phase, 'Waiting for the Solana network to answer…') });
  });
  try {
    const blocker = await preflight(req, owner, d.device);
    if (blocker) return fail(blocker.error, 'preflight', blocker.action ?? null, req.node);
    if (isCancelled()) return stoppedByUser('Connecting stopped. Nothing was paid.', req.node);
    if (!snapshot().session) {
      if (!known) await adoptRunningSession();
      await ensureHomeIp(known);
    }
    if (req.switch && snapshot().session) {
      patch({ conn: viewFor('disconnecting', 'Leaving the current server…') });
      // Kill switch on: dvpnd keeps the block through the switch; the RPC stays reachable through it.
      const stopped = await disconnect({ keepKillSwitch: getDaemonSettings().settings.killSwitch !== 'off' });
      if (!stopped.ok) return fail(stopped.error ?? 'Could not leave the current server.', stopped.code ?? 'stop-failed', stopped.action ?? null);
      patch({ conn: viewFor('connecting', 'Waiting for your connection to come back…') });
      if (!await waitForDirectPath()) return fail('You left the old server, but your internet has not come back yet, so nothing was paid for the new one. Wait a moment and connect again.', 'switch-offline', 'Retry');
    }
    let cred: Credential;
    if (req.subscription) {
      // A plan's max_connections counts TICKETS until they expire, not live sessions, so a fresh
      // ticket per connect would use the plan up. Reuse one the daemon already holds for this server.
      const held = await heldTicket(req.subscription.subscription, req.node);
      if (!held) {
        const limit = await planLimitReached(req.subscription.subscription);
        const servers = limit ? (limit.max === 1 ? '1 server' : `${limit.max} servers`) : '';
        if (limit) return fail(`This plan gives access on ${servers}, and you already use ${limit.max === 1 ? 'it' : 'them'}. Connect to one of those, or get another plan.`, 'plan-limit', 'Pick a server you already use');
      }
      cred = held ? { ticketHash: held } : { ticketRequest: req.subscription };
      patch({ conn: viewFor('connecting', held ? 'Using your plan access for this server…' : 'Getting access from your plan…') });
    } else {
      const mode = req.basis === 'per_hour' ? MODE_STREAM : MODE_VOUCHER;
      const node = await discoverNode(req.node);
      const cost = costPreview(node!, req.basis, req.units);
      const found = await reusableChannel(req.node, mode, prepayCost(node!, req.basis));
      const reuse = found && claimForReuse(found) ? found : null;
      if (found && !reuse) log.info('that deposit is closing; paying a new one', { channel: found });
      cred = reuse ? { channel: reuse } : { newChannel: { mode, escrow: cost.escrow } };
      patch({ conn: viewFor(reuse ? 'connecting' : 'paying', reuse ? 'Using your existing deposit with this server…' : `Paying deposit ${cost.escrowText}…`) });
    }
    // Everything chain-side is read BEFORE the tunnel starts: right after it starts, routes and
    // DNS are still moving and a read can fail although the session is up (clean-VM run).
    const country = (await discoverNode(req.node).catch((err: Error) => { log.warn('node lookup before connect', { err: err.message }); return null; }))?.country ?? '';
    // Last check before dvpnd pays the deposit (DC1: a Disconnect from another process lands here).
    if (isCancelled()) return stoppedByUser('Connecting stopped. Nothing was paid.', req.node);
    let s: DaemonSession;
    try {
      s = await startWithRetry(req.node, cred, !!req.subscription, req.basis);
    } catch (err) {
      if ('ticketHash' in cred && req.subscription) {
        // The stored ticket was refused (data cap used, or expired early): ask the provider for a new one.
        log.warn('stored ticket refused; requesting a new one', { err: (err as Error).message });
        s = await startWithRetry(req.node, { ticketRequest: req.subscription }, true);
        return sessionStarted(s, country);
      }
      if (!('channel' in cred)) throw err;
      const msg = (err as Error).message;
      // peer_limit_reached on a REUSED channel usually means the node still holds that channel's
      // last session (its close was lost; it frees after idle_timeout). Pay a fresh deposit only
      // when the node's own metadata shows free slots, so a full server never takes a second one.
      const busyChannel = /peer_limit_reached/.test(msg) && await nodeHasRoom(req.node);
      if (!busyChannel && !/cannot cover the prepay|prepay_below_minimum|channel_not_open|channel_node_reopened|channel_node_stale|account not found/.test(msg)) throw err;
      log.warn('existing deposit refused; opening a new one', { channel: cred.channel, err: (err as Error).message });
      const node = await discoverNode(req.node);
      const cost = costPreview(node!, req.basis, req.units);
      patch({ conn: viewFor('paying', `Paying deposit ${cost.escrowText}…`) });
      s = await startWithRetry(req.node, { newChannel: { mode: req.basis === 'per_hour' ? MODE_STREAM : MODE_VOUCHER, escrow: cost.escrow } }, false, req.basis);
    }
    if (isCancelled()) return await stopAfterStart(s, req.node, country);
    await firstData(s);
    if (isCancelled()) return await stopAfterStart(s, req.node, country);
    return sessionStarted(s, country);
  } catch (err) {
    // After the user pressed Cancel, whatever the start failed with is the stop they asked for: the app's
    // own retry throws 'cancelled', dvpnd says "stop requested while connecting", and on gate30 (dvpnd
    // 18.31) that text never arrived ("9 FAILED_PRECONDITION: "), which showed "Connection failed".
    const copy = isCancelled() ? connectErrorCopy('stop requested while connecting') : connectErrorCopy((err as Error).message);
    // An expected refusal is not an app error: Cancel is info, and dvpnd refusing a second start while a
    // session is live (a switch racing a connect that is still coming up) is warn (Q0229).
    const level = copy.code === 'cancelled' ? 'info' : copy.code === 'session-active' ? 'warn' : 'error';
    log[level]('connect failed', { node: req.node, code: copy.code, err: (err as Error).message });
    patch({ session: null });
    // A failed start can leave the tunnel service up with no session: the computer is offline (gap #29).
    // A tunnel that belongs to a session dvpnd still runs (or is still bringing up) is that session's,
    // not a leftover: a refused `connect --switch` during another connect named the live session's
    // xray.exe and sent the user to Restore network, which ends it (Q0191).
    const owner = await runningSessionId();
    const left = owner ? [] : await leftoverTunnels();
    if (owner) log.info('connect failed; the tunnel running belongs to session', { session: owner });
    if (left.length) {
      log.warn('connect failed and left a tunnel service running', { left });
      const message = `${copy.message} It also left a VPN tunnel running, which blocks your internet: press Restore network.`;
      patch({ conn: { ...viewFor('error', message), restoreNetwork: true } });
      return { ok: false, error: message, code: 'tunnel-left', action: 'restore-network' };
    }
    if (copy.code === 'cancelled') return stoppedByUser(copy.message, req.node);
    // Another VPN on is the usual cause of a failed connect (rival-d9): name it (D6).
    const rivals = await rivalVpns();
    if (rivals.length) return fail(`${copy.message} Another VPN (${rivals.join(', ')}) is on and is probably blocking this: turn it off, then connect again.`, copy.code, copy.action, req.node);
    return fail(copy.message, copy.code, copy.action, req.node);
  } finally {
    stopRetryNote();
    if (markDir) clearConnecting(markDir);
  }
}

/**
 * The daemon has a live session. From here nothing may report the connect as failed
 * (that cleared the session in the app while the tunnel stayed up): bookkeeping
 * problems are logged, never thrown.
 */
async function sessionStarted(s: DaemonSession, country: string): Promise<Result<LiveSession>> {
  resetRpcTransport(); // sockets opened before the tunnel use the old route
  flushDnsCache(); // answers cached on the direct path (or failures from the first second) are stale now
  const live = toLive(s);
  // V2Ray/Xray are a SOCKS proxy: without the system proxy the browser keeps the user's own IP
  // while the app said "Connected" (owner 2026-10-21). Default: send apps through it now.
  // Set BEFORE the session is published, so no screen shows "proxy-only" for a moment.
  // Whole-device sessions (Windows TUN) already cover every app: no proxy, so the split
  // tunnelling choice decides for browsers too.
  let proxyNote = '';
  // Android: V2Ray/Xray already run through the VpnService (tun2socks), so there is no system proxy
  // to set; dvpnd still reports its local SOCKS port as proxyEndpoint (builder-kb question, 10-24).
  if (live.proxyEndpoint && !isAndroid() && getSettings().proxyOnConnect && !serviceUsesTun(live.service)) {
    try {
      await setSystemProxy(live.proxyEndpoint);
    } catch (err) {
      log.warn('system proxy not set at connect', { err: (err as Error).message });
      proxyNote = ` Browsers are not using it yet: ${(err as Error).message}`;
    }
  }
  setSplitInEffect(splitForSession(live.service));
  patch({ session: live, conn: viewFor(phaseFromDaemon(s.status, s.error)), lastConnectError: null });
  try {
    recordStart(live, country);
  } catch (err) {
    log.warn('history record failed', { err: (err as Error).message });
  }
  watch(s.id);
  const c = snapshot().conn.title;
  toast(proxyNote ? 'warn' : 'success', proxyNote ? `Connected.${proxyNote}` : c.startsWith('Protected') || c.startsWith('Connected, checking') ? 'Connected' : c);
  return { ok: true, data: live };
}

/**
 * Cancel while connecting. The flag alone was only read before the deposit and between retries, so
 * a Cancel pressed during "Paying deposit…" or "Connecting…" was ignored and the app connected
 * anyway. dvpnd is asked to stop too (what the CLI's disconnect does): it fails the start with
 * "stop requested while connecting", whatever step it was on.
 */
export async function cancelConnect(): Promise<void> {
  cancelled = true;
  if (snapshot().session) return;
  try {
    await daemon().stopSession('');
  } catch (err) {
    if ((err as { kind?: string }).kind !== 'not-found') log.warn('cancel: could not ask the VPN service to stop connecting', { err: (err as Error).message });
  }
}

/** The Cancel landed just after dvpnd finished starting: take that session down again (its deposit
 *  is settled like any Disconnect). If the stop fails, show it as connected, which is the truth. */
async function stopAfterStart(s: DaemonSession, node: string, country: string): Promise<Result<LiveSession>> {
  log.info('connect finished after Cancel; stopping it', { id: s.id });
  try {
    const r = await stopLiveOrCurrent(s.id, daemon());
    await ended(r.session ? toLive(r.session) : toLive(s), 'closed by client');
  } catch (err) {
    log.warn('could not stop the session started after Cancel; showing it', { err: (err as Error).message });
    toast('warn', 'Cancel came too late: the connection is up. Press Disconnect to end it.');
    return sessionStarted(s, country);
  }
  return stoppedByUser('Connecting stopped. The unused deposit comes back when it closes.', node);
}

// ─── Live updates: WatchSession stream, GetSession poll fallback ───
/** Set while disconnect() runs: it owns the view until the daemon list and direct internet confirm (W5d-b). */
let disconnectRunning = false;

/**
 * DIR/QA 10-30 (QA fedora, wg cut lifted 5 s into the redial): dvpnd recovered the session as a NEW
 * one; the app cleared the old one (Q0361, "The connection to this server stopped working.") and showed
 * the new one with the timer reset. dvpnd now links them (replaced_by on the old, replaces on the new):
 * follow the link as the same session: no end notice, no settle, one timer, totals carried on, and
 * "Reconnecting" until the new session's first IP check (app-state). False = nothing to follow.
 */
export async function followRedial(old: LiveSession, newId: string, list?: DaemonSession[]): Promise<boolean> {
  let rows = list;
  if (!rows) {
    try {
      rows = await daemon().listSessions();
    } catch (err) {
      log.warn('could not read the reconnected session from the VPN service', { from: old.id, to: newId, err: (err as Error).message });
      return false;
    }
  }
  const n = rows.find((x) => x.id === newId && phaseFromDaemon(x.status, x.error) !== 'idle');
  if (!n || disconnectRunning) return false;
  chainCarry.delete(old.id);
  // the old session's own counters + what it already carried (old comes from toLive, which holds both)
  chainCarry.set(n.id, { rx: big(old.rxBytes), tx: big(old.txBytes), spent: big(old.spent), start: old.startedAt });
  if (foreign.delete(old.id)) foreign.add(n.id);
  setRedialFollow(n.id);
  const next = toLive(n); // chain start from dvpnd, else the shown session's (carried): one timer
  patch({ session: next, conn: viewFor(phaseFromDaemon(n.status, n.error)) });
  watch(n.id);
  log.info('the VPN service reconnected this session as a new one; following it', { from: old.id, to: n.id });
  return true;
}

function watch(id: string): void {
  stopWatching();
  const onUpdate = (s: DaemonSession): void => {
    // The stream reports the session closed while stopSession is still tearing the tunnel down;
    // acting on it would show "Not connected" before the internet is back (W5d-b).
    if (disconnectRunning) return;
    const live = toLive(s);
    const phase = phaseFromDaemon(s.status, s.error);
    if (phase === 'idle' && s.replacedBy) {
      // dvpnd brought it back as a new session: follow it as the same one; a plain end only if that fails
      void followRedial(live, s.replacedBy).then((ok) => { if (!ok) void ended(live, s.error); });
      return;
    }
    if (phase === 'idle') { log.info('session ended (stream)', { id: s.id, error: s.error }); void ended(live, s.error); return; }
    patch({ session: live, conn: viewFor(phase, s.error ? 'The daemon is retrying the connection.' : '') });
  };
  try {
    unwatch = daemon().watchSession(id, onUpdate, (err) => {
      if (err) log.warn('watch stream ended; polling instead', { err: err.message });
      else log.info('watch stream closed by the service', { id, shown: snapshot().session?.id ?? null });
      unwatch = null;
      if (snapshot().session) startPolling(id, onUpdate);
    });
  } catch (err) {
    log.warn('watch unavailable; polling', { err: (err as Error).message });
    startPolling(id, onUpdate);
  }
}

function startPolling(id: string, onUpdate: (s: DaemonSession) => void): void {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const s = await daemon().getSession(id);
      if (disconnectRunning) return;
      if (!s) void ended(snapshot().session, 'closed by client');
      else onUpdate(s);
    } catch (err) {
      log.debug('session poll failed', { err: (err as Error).message });
    }
  }, (getSettings().poll?.session ?? DEFAULT_POLL.session) * 1000);
}

function stopWatching(): void {
  if (unwatch) { unwatch(); unwatch = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Returns the system-proxy restore so a caller that exits next (the CLI) can wait for it. */
function ended(live: LiveSession | null, reason: string, opts: { holdDisconnecting?: boolean } = {}): Promise<void> {
  stopWatching();
  setSplitInEffect(null);
  if (live) chainCarry.delete(live.id); // recordEnd below already got the chain's totals through toLive
  resetRpcTransport(); // the default route just moved back
  const copy = closeReasonCopy(reason);
  if (live) recordEnd(live, reason);
  const unexpected = !!reason && !/closed by client/i.test(reason);
  const heldView = endedHeldView(isAndroid(), getDaemonSettings().settings.killSwitch !== 'off', unexpected && !opts.holdDisconnecting, copy);
  // disconnect() keeps "Disconnecting…" until the daemon list and direct internet confirm (W5d-b)
  patch({ session: null, conn: heldView ?? viewFor(opts.holdDisconnecting ? 'disconnecting' : 'idle'), lastCloseMessage: copy });
  if (heldView) void confirmHeldAfterEnd(); // the one end screen, checked at once (not after a 'Not connected' step)
  // The CLI leaves its deposit open on purpose (a reconnect reuses it; it prints the settle hint).
  // A CLI session the open app picked up must not be start-closed later (the Android app grid F9.2), and a
  // "switching servers" end queues none (Q0411: switching back reuses the deposit).
  if (live?.channel && !foreign.delete(live.id) && settlesOnEnd(reason)) settleChannelSoon(live.channel);
  // Awaited by disconnect(): the CLI exits right after, and a restore still running was lost
  // (the macOS app matrix: the SOCKS proxy stayed set after every V2Ray/Xray CLI disconnect).
  const proxyBack = clearSystemProxy().catch((err) => log.warn('system proxy restore after the session ended failed', { err: (err as Error).message }));
  if (unexpected && !heldView) {
    toast('warn', copy.message);
    // An unexpected end with the kill switch on leaves the internet BLOCKED (dvpnd keeps it);
    // the screens must say "Blocking internet" + Restore network, not "Not connected"
    // (VM test-host 2026-10-22: xray killed → 0 leaks, but the page said "Nothing is blocked").
    setTimeout(() => { void checkLeftoverBlock(copy).catch((err) => log.warn('leftover-block check after an unexpected end failed', { err: (err as Error).message })); }, 3000);
  }
  return proxyBack;
}

/**
 * Q0366 end copy (TAN lab-q0366k): an unexpected end with the kill switch on showed two screens, 'Not
 * connected / The connection to this server stopped working.' and ~3 s later the blocked screen.
 * The spec (and the desktop strings) is one: why it ended + the kill switch is still blocking + Restore
 * network. On Android dvpnd keeps the kill switch after it gives up, so that screen is shown at once;
 * confirmHeldAfterEnd falls back to the plain end only if the VPN service holds nothing.
 * null = the usual idle view (desktop, kill switch off, or a user's own stop).
 */
export function endedHeldView(android: boolean, killSwitchOn: boolean, unexpected: boolean, copy: Copy): (ReturnType<typeof viewFor> & { restoreNetwork: true }) | null {
  if (!android || !killSwitchOn || !unexpected) return null;
  return { ...viewFor('error', blockedAfterEnd(copy, BLOCKED_HELD_ANDROID)), restoreNetwork: true };
}

async function confirmHeldAfterEnd(): Promise<void> {
  const showing = (): boolean => !snapshot().session && snapshot().conn.phase === 'error' && !!snapshot().conn.restoreNetwork;
  const held = await androidHeldBlock().catch((err: unknown) => { log.warn('vpn state unreadable after the session ended', { err: (err as Error).message }); return null; });
  if (held !== false || !showing()) return; // held (or unknown): the blocked screen stays
  log.info('the session ended and the VPN interface is not held: plain end');
  patch({ conn: viewFor('idle') });
}

/**
 * A kill switch dvpnd kept with no session (persist mode after dvpnd restarted, e.g. a crash) is
 * released only by StopSession with no id. True when one was released.
 */
export async function releaseKeptKillSwitch(): Promise<boolean> {
  try {
    const held = await daemon().stopSession('');
    return !!held.killSwitchReleased;
  } catch (err) {
    if ((err as { kind?: string }).kind !== 'not-found') throw err; // not-found = nothing held
    return false;
  }
}

/** Hold Disconnect until dvpnd no longer lists the session as running (W5 e: after a Hysteria2 app
 *  Disconnect the CLI `status` still read an active session, "Connected, but traffic is not going
 *  through the VPN", while direct internet was already back). Bounded; a list error ends the wait. */
async function sessionGone(id: string): Promise<void> {
  const took = await waitForDirect({
    probe: async () => {
      try { return !(await daemon().listSessions()).some((x) => x.id === id && phaseFromDaemon(x.status, x.error) !== 'idle'); } catch (err) { log.warn('disconnect: could not list sessions', { err: (err as Error).message }); return true; }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  }, 15_000, 1000);
  if (took === null) log.warn('disconnect: dvpnd still lists the session as running after 15 s', { id });
  else if (took > 1000) log.info('disconnect: session left the daemon list', { id, ms: took });
}

/** Hold Disconnect until a direct request answers (W5 d). Only with the kill switch off (otherwise
 *  the block is meant to stay) and IP checks on (the probe is an outside request); bounded. */
async function directBack(opts: { keepKillSwitch?: boolean }): Promise<void> {
  if (opts.keepKillSwitch || getDaemonSettings().settings.killSwitch !== 'off' || !getSettings().thirdPartyChecks) return;
  const took = await waitForDirect({
    probe: async () => 'ip' in await publicIp(4000),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  });
  if (took === null) log.warn('disconnect: direct internet did not answer within 25 s');
  else if (took > 2000) log.info('disconnect: direct internet back', { ms: took });
}

/** User Disconnect: stop, then queue settlement of that channel (F12). keepKillSwitch: a server switch (gap #67). */
export async function disconnect(opts: { keepKillSwitch?: boolean } = {}): Promise<Result> {
  const live = snapshot().session;
  if (!live && !opts.keepKillSwitch) {
    // DC1: a connect still running in another process (the CLI) is stopped, not ignored.
    const other = await stopOtherConnect();
    if (other.stopped) {
      await adoptRunningSession();
      if (snapshot().session) return disconnect(opts); // it got up before the stop landed: take it down
    }
  }
  if (!live) {
    // No session here, but dvpnd may still HOLD the kill switch: after it crashed mid-session
    // (rc+ keeps the block, the user never disconnected) or persist mode after a restart.
    // "Disconnect" must give the internet back, so release it (not-found = nothing held).
    try {
      const held = await daemon().stopSession('');
      if (held.killSwitchReleased) log.info('disconnect: released a kill switch held with no session');
    } catch (err) {
      if ((err as { kind?: string }).kind !== 'not-found') log.warn('disconnect: could not check for a held kill switch', { err: (err as Error).message });
    }
    // A session that ended on its own (service restart) can leave our system proxy on.
    await clearSystemProxy().catch((err) => log.warn('disconnect: system proxy restore failed', { err: (err as Error).message }));
    patch({ conn: viewFor('idle') });
    return { ok: true };
  }
  disconnectRunning = true;
  patch({ conn: viewFor('disconnecting') });
  foreign.delete(live.id); // Disconnect pressed here: settle it like any session of ours
  try {
    const r = await stopLiveOrCurrent(live.id, daemon(), opts);
    flushDnsCache(); // tunnel answers are stale on the direct path
    await ended(r.session ? toLive(r.session) : live, 'closed by client', { holdDisconnecting: true });
    await sessionGone(live.id);
    await directBack(opts);
    patch({ conn: viewFor('idle') });
    if (r.dnsRevertFailed && await dnsReallyLeftOver(getDaemonSettings().settings.dnsServers)) {
      patch({ conn: { ...viewFor('error', 'Your internet may not work: DNS could not be restored.'), restoreNetwork: true } });
      return { ok: false, error: 'DNS could not be restored.', code: 'dns-revert-failed', action: 'Restore network' };
    }
    return { ok: true };
  } catch (err) {
    log.error('stopSession failed', err);
    patch({ conn: { ...viewFor('error', 'Your internet may not work.'), restoreNetwork: true } });
    return { ok: false, error: 'Your internet may not work.', code: 'stop-failed', action: 'Restore network' };
  } finally {
    disconnectRunning = false;
  }
}

/** The id of a session dvpnd runs or is bringing up, or null (none, or the daemon could not say). */
async function runningSessionId(): Promise<string | null> {
  try {
    return (await daemon().listSessions()).find((x) => phaseFromDaemon(x.status, x.error) !== 'idle')?.id ?? null;
  } catch (err) {
    log.warn('connect failed; could not list sessions', { err: (err as Error).message });
    return null;
  }
}

/**
 * Q0361: a session the app shows as connected but dvpnd no longer runs is cleared, so the screen
 * never stays "Connected" (and the Connect buttons blocked) after its end went unseen. Seen on
 * Android: the app adopted a CLI session while the CLI was disconnecting it and missed the end.
 * Two misses in a row (one poll apart) before acting, so a session between dvpnd steps is left alone;
 * a different running session (dvpnd reconnected under a new id) is adopted. True when it cleared one.
 */
let missedId: string | null = null;

/**
 * The session dvpnd is running. During a redial its list also holds the attempt's stored row, which
 * reads "active" before the attempt's tunnel check (Q0366 pass 2), so a reconnecting or checking
 * entry (dvpnd's live copy) wins over a plain active row.
 */
export function runningSession(list: DaemonSession[]): DaemonSession | undefined {
  const running = list.filter((x) => phaseFromDaemon(x.status, x.error) !== 'idle');
  return running.find((x) => ['reconnecting', 'checking'].includes(phaseFromDaemon(x.status, x.error))) ?? running[0];
}

/** Views a dvpnd session can be gone under: connected, and reconnecting (Q0366: dvpnd gave up while
 *  the app watched its reconnect placeholder; while dvpnd reconnects it lists the session as running). */
const RECONCILED_PHASES = new Set(['connected', 'reconnecting']);
export async function reconcileShownSession(d: Pick<DaemonClient, 'listSessions'> = daemon()): Promise<boolean> {
  const live = snapshot().session;
  if (!live || disconnectRunning || !RECONCILED_PHASES.has(snapshot().conn.phase)) { missedId = null; return false; }
  let list: DaemonSession[];
  try {
    list = await d.listSessions();
  } catch (err) {
    log.debug('session check: could not list sessions', { err: (err as Error).message });
    return false;
  }
  const now = snapshot();
  if (now.session?.id !== live.id || disconnectRunning || !RECONCILED_PHASES.has(now.conn.phase)) { missedId = null; return false; }
  const running = runningSession(list);
  // Q0366 pass 2 (QA fedora, wg cut; port of the Linux app 3044f7e6): during a redial dvpnd lists the attempt
  // FIRST (its stored row reads "active" before its tunnel check, or its live copy "checking") and the
  // shown session second, still running. Taking the first running one as "the" session swapped the
  // shown session for the attempt: a green "Connected" with the timer reset, and its stream was
  // dropped, so dvpnd's give-up reason never arrived. The shown session is kept while dvpnd lists IT
  // as running; another one is adopted only once ours has ended or is gone.
  if (list.some((x) => x.id === live.id && phaseFromDaemon(x.status, x.error) !== 'idle')) { missedId = null; return false; }
  // dvpnd brought it back as a new session (its row names the successor, or the successor names it):
  // the same session to the user, followed at once, never cleared with "stopped working" (DIR/QA 10-30)
  const by = list.find((x) => x.id === live.id)?.replacedBy;
  const successor = list.find((x) => (by ? x.id === by : x.replaces === live.id) && phaseFromDaemon(x.status, x.error) !== 'idle');
  if (successor) { missedId = null; return followRedial(live, successor.id, list); }
  if (missedId !== live.id) { missedId = live.id; return false; }
  missedId = null;
  const row = list.find((x) => x.id === live.id);
  log.warn('the shown session is no longer running in the VPN service; clearing it (Q0361)', { id: live.id, status: row?.status ?? null, running: running?.id ?? null });
  await ended(row ? toLive(row) : live, row?.error || 'closed by client');
  if (running) await adoptRunningSession({ applyProxy: !isAndroid(), startedElsewhere: true });
  return true;
}

/** On app start: adopt a session the daemon still runs (never auto-start one). */
let known = false;
/** True once the app has asked the daemon for running sessions (or found it unreachable). */
export function sessionsKnown(): boolean {
  return known;
}

/** True while the screen shows "Checking the connection…" for a connect started elsewhere (Q0357). */
let outsideChecking = false;
export function outsideCheckShown(): boolean {
  return outsideChecking;
}

// Q0373 (Windows, Q0366 cut; port of the Windows app a67c5ef): during dvpnd's redial a ListSessions call dropped;
// the app took that as "no session", then the internet check (blocked by the kill switch holding for
// the redial) offered Restore network, which drops the block mid-redial. A failed read on a RUNNING
// daemon now means "unknown": never "no session", never Restore network. Only a daemon that is not
// running at all proves no session of ours runs.
let sessionsUnreadable = false;
/** True when the last session read failed while dvpnd was running: whether a session runs is unknown. */
export function sessionStateUnknown(): boolean { return sessionsUnreadable; }
/** Whether dvpnd is known to be running; a failed read of that (store not ready) counts as not known. */
function daemonRunning(): boolean {
  try {
    return daemonInfo().reachable;
  } catch (err) {
    log.warn('could not read the VPN service state', { err: (err as Error).message });
    return false;
  }
}

export async function adoptRunningSession(opts: { applyProxy?: boolean; startedElsewhere?: boolean } = {}): Promise<void> {
  try {
    const list = await daemon().listSessions();
    known = true;
    sessionsUnreadable = false;
    const s = runningSession(list);
    // A connect started elsewhere and still in its tunnel check: say so, adopt it once it is live.
    if (!snapshot().session) {
      const step = outsideCheck(s, outsideChecking);
      if (step === 'show') {
        outsideChecking = true;
        patch({ conn: viewFor('checking') });
        log.info('a connect started elsewhere is checking its tunnel', { id: s?.id });
      }
      if (step === 'show' || step === 'keep') return;
      if (step === 'clear') {
        outsideChecking = false;
        patch({ conn: viewFor('idle') });
        log.info('the connect started elsewhere did not come up');
      }
    }
    outsideChecking = false;
    if (!s) return;
    const shown = snapshot().session;
    if (shown && s.replaces === shown.id && await followRedial(shown, s.id, list)) return;
    const fresh = shown?.id !== s.id;
    if (opts.startedElsewhere && fresh) foreign.add(s.id);
    // a CLI (no shown session) picking up a reconnect chain: the earlier rows' totals from dvpnd's list
    if (s.replaces && !chainCarry.has(s.id)) chainCarry.set(s.id, chainTotals(list, s));
    const live = toLive(s);
    setSplitInEffect(splitForSession(live.service));
    patch({ session: live, conn: viewFor(phaseFromDaemon(s.status, s.error)) });
    watch(s.id);
    log.info('adopted running session', { id: s.id, node: s.node });
    // App only (never a CLI `status`): a V2Ray/Xray session found at start gets the same
    // "send apps through the VPN" as one started here, so the app never says connected while
    // the browser keeps the user's own IP.
    if (opts.applyProxy && fresh && live.proxyEndpoint && !isAndroid() && getSettings().proxyOnConnect && !snapshot().proxyActive && !serviceUsesTun(live.service)) {
      try {
        await setSystemProxy(live.proxyEndpoint);
      } catch (err) {
        log.warn('system proxy not set for the adopted session', { err: (err as Error).message });
      }
    }
  } catch (err) {
    known = true;
    // Not running: no session of ours can be. Running but the call failed (busy redialing): unknown.
    sessionsUnreadable = daemonRunning();
    log.warn('could not list daemon sessions', { err: (err as Error).message, daemonRunning: sessionsUnreadable });
  }
}

const BLOCKED_NO_SESSION = 'Your internet is not working and no VPN session is running. If the VPN was on before, its kill switch may still be blocking traffic.';
const BLOCKED_HELD_ANDROID = 'The kill switch is blocking your internet: the VPN dropped and nothing leaves the phone outside it. Reconnect, or press Restore network.';

/**
 * What the blocked-internet screen says. After a session ended on its own (endedCopy = why, from dvpnd)
 * it keeps that reason: Q0366 pass 2 (QA fedora; port of the Linux app 3044f7e6) showed only the general text
 * after dvpnd gave up reconnecting, hiding "The connection to this server stopped working." The kill
 * switch is still on then (kept until the user disconnects), so Restore network stays offered.
 */
export function blockedAfterEnd(endedCopy: Copy | null, general = BLOCKED_NO_SESSION): string {
  if (!endedCopy) return general;
  const next = endedCopy.action ? `${endedCopy.action.toLowerCase()}, or press Restore network` : 'press Restore network';
  return `${endedCopy.message} The kill switch is still blocking the internet to protect you: ${next} to get it back.`;
}

/**
 * Dead-internet check (F14.3): no session, yet nothing answers — usually a kill switch
 * left behind by a daemon that died. Offers "Restore network"; never changes anything itself.
 */
export async function checkLeftoverBlock(endedCopy: Copy | null = null): Promise<boolean> {
  const s = snapshot();
  if (s.session || s.conn.phase !== 'idle') return false;
  // Q0373: read dvpnd again; a running daemon that cannot answer may be redialing a session.
  await adoptRunningSession();
  if (snapshot().session) return false;
  if (sessionsUnreadable) {
    log.warn('the VPN service is running but did not list its sessions: not offering Restore network (it may be reconnecting)');
    return false;
  }
  // A tunnel with no session can leave the internet WORKING, through a node, still billed
  // (gap the Linux app): look for one before the reachability check, which would say all is well.
  const left = await leftoverTunnels();
  if (left.length && !snapshot().session) {
    log.warn('no session but a VPN tunnel is still running: offering Restore network', { left });
    patch({ conn: { ...viewFor('error', 'A VPN connection from before is still running without this app. Your traffic may still go through a server. Press Restore network to stop it.'), restoreNetwork: true } });
    return true;
  }
  // Android: this app's own traffic is outside the VPN, so "is the internet reachable" always
  // says yes. The VPN service knows whether it is holding the interface with no session.
  if (isAndroid()) {
    const held = await androidHeldBlock().catch((err: unknown) => { log.warn('vpn state unreadable', { err: (err as Error).message }); return null; });
    if (!held || snapshot().session) return false;
    log.warn('no session and the VPN interface is held: offering Restore network', { ended: endedCopy?.message ?? null });
    patch({ conn: { ...viewFor('error', blockedAfterEnd(endedCopy, BLOCKED_HELD_ANDROID)), restoreNetwork: true } });
    return true;
  }
  if (await internetReachable(getRpcUrls())) return false;
  if (snapshot().session) return false; // a session started while we checked
  log.warn('no session and no internet: offering Restore network', { ended: endedCopy?.message ?? null });
  patch({ conn: { ...viewFor('error', blockedAfterEnd(endedCopy)), restoreNetwork: true } });
  return true;
}

/** Remove dvpn tunnel services left running with no session. Returns an error message, or null when none are left. */
async function removeOrphanTunnels(): Promise<string | null> {
  const left = await leftoverTunnels();
  if (!left.length) return null;
  log.warn('leftover tunnel services with no session', { left });
  const r = await removeTunnelServices();
  return r.ok ? null : `A VPN tunnel was left running and could not be removed (${r.detail}). Restart Windows to clear it.`;
}

/** "Restore network": stop whatever the daemon holds so it releases kill switch + DNS (F14.3). */
export async function restoreNetwork(retried = false): Promise<Result> {
  try {
    const list = await daemon().listSessions();
    for (const s of list) {
      if (phaseFromDaemon(s.status, s.error) === 'idle') continue;
      const r = await daemon().stopSession(s.id);
      recordEnd(r.session ? toLive(r.session) : toLive(s), 'restored network');
      if (r.dnsRevertFailed && await dnsReallyLeftOver(getDaemonSettings().settings.dnsServers)) return { ok: false, error: DNS_NOT_RESTORED_COPY(), code: 'dns-revert-failed' };
    }
    // A kill switch dvpnd KEPT with no live session (persist mode after a restart, or a failed
    // re-apply) is released only by StopSession, which dvpnd accepts with no session at all.
    // Skipping it because the session list was empty left a VM offline for good (R3, gap the macOS app).
    if (await releaseKeptKillSwitch()) log.info('restore network: released a kept kill switch');
    stopWatching();
    await clearSystemProxy();
    // No session left, yet a dvpn tunnel service may still hold the default route (gap #29).
    const stuck = await removeOrphanTunnels();
    if (stuck) return { ok: false, error: stuck, code: 'tunnel-left' };
    patch({ session: null, conn: viewFor('idle') });
    return { ok: true };
  } catch (err) {
    // A dead daemon can leave its kill switch blocking everything; restarting the service
    // makes it release (proven on the box rig, TEST-PLAN T14). Its tunnel is orphaned too.
    log.warn('restore network: daemon did not answer', { err: (err as Error).message });
    if (isAndroid()) {
      // A phone has no service to restart by hand: the app restarts its VPN engine itself (as
      // Settings does), and the user presses Restore network once more (C16, no Windows wording).
      const re = await restartAndroidDaemon();
      if (!re.ok) log.warn('restore network: VPN engine restart failed', { err: re.error });
      return { ok: false, error: re.ok ? ANDROID_ENGINE_RESTARTED_COPY : ANDROID_ENGINE_DOWN_COPY, code: 'daemon-unavailable' };
    }
    await removeOrphanTunnels();
    // A stopped service is started without elevation (old installs: 'no-right'); once it
    // answers, one more pass releases its kill switch. Same as linux-app 19bff7a7 (C18).
    if (!retried) {
      const svc = await startServiceIfStopped();
      log.info('restore network: service start', { svc });
      if (svc === 'started' && (await waitForDaemon(SERVICE_WAIT_MS, daemonInfo)).reachable) return restoreNetwork(true);
    }
    return { ok: false, error: 'The VPN service is not answering. Restart Windows, then press Restore network again.', code: 'daemon-unavailable' };
  }
}

export const ANDROID_ENGINE_RESTARTED_COPY = 'The VPN engine was not answering, so the app restarted it. Press Restore network again.';
export const ANDROID_ENGINE_DOWN_COPY = 'The VPN engine is not answering and could not be restarted. Close the app from Recent apps (or restart the phone), then press Restore network again.';
export const DNS_NOT_RESTORED_COPY = (): string => (isAndroid()
  ? 'DNS could not be restored. Turn Wi-Fi or mobile data off and on, or restart the phone.'
  : 'DNS could not be restored. Reconnect your network adapter or restart Windows.');
