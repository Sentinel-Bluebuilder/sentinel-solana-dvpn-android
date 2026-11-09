// ─── Settlement executor (F12, D3) ───
// Only channels THIS device opened (opener == device) are touched — the owner may
// have channels from other apps/devices — unless the user names another device
// whose spending permission is already removed (gap #95). Live-session channels are
// skipped. Voucher: start_close, then close after the grace. Stream: close now.
// Refunds land in User.balance; withdraw moves them back to the wallet.
import type { PendingSettlement, Result } from '../../shared/types';
import { channelsByOwner, userByOwner } from '../../core/chain/accounts';
import { fetchConfig } from '../../core/chain/program';
import { closeChannel, startCloseChannel, withdrawUserBalance } from '../../core/chain/builders';
import { balanceGone, channelGone, daemonWentAway, planChannel, refundable, streamLeft, type ChainChannel, type StreamFields } from '../../core/settlement/settlement';
import { MODE_STREAM } from '../../core/chain/idl';
import { signAndSend } from '../../core/app/signer';
import { describeInstructionError } from '../../core/chain/errors';
import { ownerAddress, ownerSigner } from '../wallet/vault';
import { readWalletStatus } from '../../core/app/wallet-status';
import { daemon, daemonInfo } from '../daemon/manager';
import { phaseFromDaemon } from '../../core/session/state';
import { patch, snapshot, toast } from '../app-state';
import { isAndroid } from '../platform/android-bridge';
import { log } from '../logger';

let running = false;
const soon = new Map<string, ReturnType<typeof setTimeout>>();
/** Channels whose queued close already fired: start_close may be in flight or not yet visible on RPC. */
const closing = new Map<string, number>();
const CLOSING_MS = 120_000;
/**
 * How long after a session ends its deposit stays open for a reconnect (Q0411, DIR). 15 s made every
 * switch back to the same node pay a new deposit (escrow locked through the 7200 s close; QA: ~18
 * closing channels, allowance drained). 10 min = dvpnd's own finished-channel sweep.
 */
export const SETTLE_AFTER_MS = 10 * 60_000;

/** A "switching servers" end queues no close: the user is moving between servers and may be back. */
export function settlesOnEnd(reason: string): boolean {
  return !/switching servers/i.test(reason);
}

function toChain(c: Record<string, unknown>): ChainChannel {
  return {
    address: String(c.address), owner: String(c.owner), node: String(c.node), opener: String(c.opener),
    mode: Number(c.mode), status: Number(c.status), escrow: String(c.escrow ?? '0'), redeemed: String(c.redeemed ?? '0'),
    closeStartedAt: String(c.closeStartedAt ?? '0'), rentPayer: String(c.rentRecipient),
  };
}

const maxBig = (a: string, b: string): string => (BigInt(a) > BigInt(b) ? a : b);

/** Channels behind the daemon's live sessions, and what the daemon has signed per channel. Throws if the
 *  daemon is up but cannot answer: settling blind could close the channel of the session in use. */
async function liveFromDaemon(): Promise<{ channels: string[]; cumulative: Map<string, string> }> {
  if (!daemonInfo().reachable) return { channels: [], cumulative: new Map() }; // no daemon → no tunnel
  const [sessions, chans] = await Promise.all([daemon().listSessions(), daemon().listChannels()]);
  return {
    channels: sessions.filter((x) => phaseFromDaemon(x.status, x.error) !== 'idle').map((x) => x.channel).filter(Boolean),
    cumulative: new Map(chans.map((c) => [c.address, c.cumulative || '0'])),
  };
}

/**
 * Another device of this wallet (gap #95: its computer is gone, its key lost). Its deposits are
 * settled only once its spending permission is removed: without a grant it cannot be in a paid
 * session anywhere, so closing its deposits cannot cut a live connection on another computer.
 */
async function otherDeviceReady(owner: string, other: string): Promise<void> {
  if (other === daemonInfo().device) throw new Error(`That is ${isAndroid() ? 'this phone' : 'this computer'}'s device: leave out --device.`);
  const st = await readWalletStatus(owner, other);
  // code: the app shows its own words for this (Wallet → Other devices); the CLI shows the message.
  if (st.grant) throw Object.assign(new Error(`Device ${other} can still spend. Remove it first: "device revoke --device ${other} --yes".`), { code: 'device-active' });
}

/** Channels this device owns on chain, with what settling each needs. `other` = another device of this wallet (gap #95). */
export async function readSettlements(other?: string): Promise<PendingSettlement[]> {
  const owner = ownerAddress();
  const device = other ?? daemonInfo().device;
  if (!owner || !device) return [];
  if (other) await otherDeviceReady(owner, other);
  const [chans, cfg, live] = await Promise.all([channelsByOwner(owner), fetchConfig(), other ? Promise.resolve({ channels: [], cumulative: new Map<string, string>() }) : liveFromDaemon()]);
  const now = Math.floor(Date.now() / 1000);
  // In use = what the daemon itself is running, not what this process remembers: the CLI
  // (or an app started after the session) has no session in memory. Another device has no
  // session here, and with its permission removed it cannot have one anywhere.
  const inUse = new Set(other ? [] : [...live.channels, ...(snapshot().session?.channel ? [snapshot().session!.channel] : [])]);
  const out: PendingSettlement[] = [];
  for (const raw of chans) {
    const ch = toChain(raw);
    if (ch.opener !== device) continue;
    const a = planChannel(ch, { now, graceSeconds: cfg.channelCloseGraceSeconds, inUse });
    out.push({
      channel: ch.address, node: ch.node, mode: ch.mode, escrow: ch.escrow, redeemed: ch.redeemed,
      status: a.kind === 'in-use' ? 'in-use' : a.kind === 'start-close' ? 'open' : a.kind === 'wait' ? 'closing' : 'ready',
      readyAt: a.kind === 'wait' ? a.readyAt : null,
      // Per hour: the node is owed elapsed time (closing settles it), so only the unspent time comes back.
      // Per GB: on-chain redeemed lags until the node redeems; the daemon's last signed voucher is the real spend.
      refundable: (ch.mode === MODE_STREAM
        ? streamLeft(raw as unknown as StreamFields, now)
        : refundable({ ...ch, redeemed: maxBig(ch.redeemed, live.cumulative.get(ch.address) ?? '0') })).toString(),
    });
  }
  if (!other) patch({ settlements: out }); // the app's list shows this computer's deposits only
  return out;
}

/** Do every step that is due now. `only` limits it to some channels; `other` settles another device's (gap #95). Returns signatures. */
export async function runSettlement(only?: string[], other?: string): Promise<Result<string[]>> {
  if (running) return { ok: false, error: 'Settlement is already running.', code: 'busy' };
  running = true;
  const sigs: string[] = [];
  try {
    const owner = ownerAddress();
    if (!owner) return { ok: false, error: 'Set up a wallet first.', code: 'no-wallet' };
    const signer = ownerSigner();
    const chans = await channelsByOwner(owner);
    const byAddr = new Map(chans.map((c) => [String(c.address), toChain(c)]));
    // One deposit failing never stops the rest; a deposit closed elsewhere meanwhile is skipped.
    const failed: string[] = [];
    let due = 0;
    for (const p of await readSettlements(other)) {
      if (only && !only.includes(p.channel)) continue;
      if (p.status !== 'open' && p.status !== 'ready') continue;
      due++;
      const ch = byAddr.get(p.channel);
      if (!ch) continue;
      try {
        if (p.status === 'open') {
          sigs.push((await signAndSend(signer, [await startCloseChannel({ owner, channel: ch.address })], 'start_close_channel')).signature);
        } else {
          sigs.push((await signAndSend(signer, [await closeChannel({ signer: owner, ch })], 'close_channel')).signature);
        }
      } catch (err) {
        const msg = describeInstructionError(err) ?? (err as Error).message;
        if (channelGone(msg)) { log.info('settle: deposit already closed elsewhere, skipped', { channel: p.channel }); continue; }
        failed.push(msg);
        log.warn('settle: one deposit failed, going on', { channel: p.channel, err: msg });
      }
    }
    const user = await userByOwner(owner);
    if (user && BigInt(String(user.balance)) > 0n) {
      try {
        sigs.push((await signAndSend(signer, [await withdrawUserBalance({ owner, userRentPayer: String(user.rentRecipient) })], 'withdraw_user_balance')).signature);
      } catch (err) {
        const msg = describeInstructionError(err) ?? (err as Error).message;
        if (!balanceGone(msg)) throw err;
        log.info('settle: refund already withdrawn by another settle, skipped', { err: msg });
      }
    }
    await readSettlements();
    if (sigs.length) toast('success', `Settlement: ${sigs.length} transaction${sigs.length > 1 ? 's' : ''} confirmed.`);
    if (failed.length) {
      const error = `${failed.length} of ${due} deposits could not be settled (${failed[0]}). The others are done: run settle again later.`;
      log.error('settlement partly failed', { err: error, done: sigs });
      return { ok: false, error, code: 'settle-failed', data: sigs };
    }
    return { ok: true, data: sigs };
  } catch (err) {
    const msg = describeInstructionError(err) ?? (err as Error).message;
    if (daemonWentAway(err)) {
      log.warn('settlement deferred: the VPN service stopped, settle runs again later', { err: msg, done: sigs });
      return { ok: false, error: 'The VPN service stopped while settling. Nothing was closed; settle runs again later.', code: 'daemon-gone', data: sigs };
    }
    log.error('settlement failed', { err: msg, done: sigs });
    return { ok: false, error: msg, code: 'settle-failed', data: sigs };
  } finally {
    running = false;
  }
}

/** After a session ends, settle its channel later (a reconnect within SETTLE_AFTER_MS reuses it). */
export function settleChannelSoon(channel: string, delayMs = SETTLE_AFTER_MS): void {
  if (soon.has(channel)) return;
  soon.set(channel, setTimeout(() => {
    soon.delete(channel);
    closing.set(channel, Date.now());
    void runSettlement([channel]).then((r) => { if (!r.ok) log.warn('auto-settle deferred', { channel, err: r.error }); });
  }, delayMs));
}

/**
 * A connect wants to reuse this deposit. A close still waiting is cancelled (the deposit carries
 * on); one that already fired makes the deposit unusable, so the caller pays a new one. Without
 * this, Disconnect then Connect within ~20 s reused a deposit the app was closing and the node
 * ended the new session with "position closing" (ui-win-3 route run, 2026-10-22).
 */
export function claimForReuse(channel: string): boolean {
  const t = soon.get(channel);
  if (t) {
    clearTimeout(t);
    soon.delete(channel);
    log.info('queued close cancelled: a new session reuses the deposit', { channel });
    return true;
  }
  const since = closing.get(channel);
  if (since !== undefined && Date.now() - since < CLOSING_MS) return false;
  closing.delete(channel);
  return true;
}

/** Withdraw the refundable User.balance now (explicit button). */
export async function withdraw(): Promise<Result<string>> {
  const owner = ownerAddress();
  if (!owner) return { ok: false, error: 'Set up a wallet first.' };
  const user = await userByOwner(owner);
  if (!user || BigInt(String(user.balance)) === 0n) return { ok: false, error: 'Nothing to refund.', code: 'nothing' };
  try {
    const r = await signAndSend(ownerSigner(), [await withdrawUserBalance({ owner, userRentPayer: String(user.rentRecipient) })], 'withdraw_user_balance');
    return { ok: true, data: r.signature };
  } catch (err) {
    return { ok: false, error: describeInstructionError(err) ?? (err as Error).message, code: 'withdraw-failed' };
  }
}
