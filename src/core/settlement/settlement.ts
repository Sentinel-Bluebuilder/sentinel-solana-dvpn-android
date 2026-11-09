// ─── Settlement planner (F12, decision D3) ───
// dvpnd never closes channels the app asked it to stop using, and has no close
// or withdraw RPC. The app plans and signs settlement with the owner key:
//   voucher  start_close → wait channel_close_grace_seconds (7200 s) → close_channel
//   stream   close_channel immediately (node account settles accrued time)
//   then     withdraw_user_balance moves refunds from User.balance to the wallet
// Channels backing a live session are never touched.
import { CHANNEL_STATUS_CLOSING, CHANNEL_STATUS_OPEN, MODE_STREAM, MODE_VOUCHER } from '../chain/idl';

export interface ChainChannel {
  address: string;
  owner: string;
  node: string;
  opener: string;
  mode: number;
  status: number;
  escrow: string;
  redeemed: string;
  closeStartedAt: string | number;
  rentPayer: string;
}

export type SettleAction =
  | { kind: 'start-close'; channel: string }
  | { kind: 'wait'; channel: string; readyAt: number; secondsLeft: number }
  | { kind: 'close'; channel: string }
  | { kind: 'in-use'; channel: string };

export function planChannel(ch: ChainChannel, { now, graceSeconds, inUse }: { now: number; graceSeconds: number; inUse: Set<string> }): SettleAction {
  if (inUse.has(ch.address)) return { kind: 'in-use', channel: ch.address };
  if (ch.mode === MODE_STREAM) return { kind: 'close', channel: ch.address };
  if (ch.mode === MODE_VOUCHER && ch.status === CHANNEL_STATUS_OPEN) return { kind: 'start-close', channel: ch.address };
  if (ch.status === CHANNEL_STATUS_CLOSING) {
    const readyAt = Number(ch.closeStartedAt) + graceSeconds;
    if (now >= readyAt) return { kind: 'close', channel: ch.address };
    return { kind: 'wait', channel: ch.address, readyAt, secondsLeft: readyAt - now };
  }
  return { kind: 'in-use', channel: ch.address };
}

export function refundable(ch: ChainChannel): bigint {
  const e = BigInt(ch.escrow);
  const r = BigInt(ch.redeemed);
  return e > r ? e - r : 0n;
}

/** Stream fields of a chain channel (camelCase, as decoded). */
export interface StreamFields { escrow: string | number; ratePerHour?: string | number; streamBase?: string | number; streamStartedAt?: string | number }

/**
 * What a per-hour (stream) channel owes the node at `now`: stream_base plus elapsed time × rate,
 * capped at escrow. The clock runs from stream_started_at whether or not a session is up, so a
 * channel opened an hour ago is spent even if it carried one minute of traffic.
 */
export function streamOwed(ch: StreamFields, now: number): bigint {
  const escrow = BigInt(ch.escrow);
  const started = Number(ch.streamStartedAt ?? 0);
  const elapsed = started > 0 && now > started ? BigInt(Math.floor(now - started)) : 0n;
  const owed = BigInt(ch.streamBase ?? 0) + (elapsed * BigInt(ch.ratePerHour ?? 0)) / 3600n;
  return owed > escrow ? escrow : owed;
}

/** Escrow a stream channel has left at `now` (what a reused session could still spend). */
export function streamLeft(ch: StreamFields, now: number): bigint {
  return BigInt(ch.escrow) - streamOwed(ch, now);
}

/**
 * The deposit was closed by someone else (the node, or another app/CLI on this wallet) between
 * the list and our transaction: the account no longer exists. Settle skips it instead of
 * stopping (cli191 test-host 2026-10-22: one of 245 deposits aborted the whole run).
 * Two settles racing on one wallet: the loser meets ChannelNotOpen on a deposit the winner moved on.
 */
export function channelGone(msg: string): boolean {
  return /AccountNotInitialized|\(3012\)|AccountNotFound|ChannelNotOpen|\(6032\)|could not find account/i.test(msg);
}

/**
 * The wallet's refund balance was already withdrawn between our read and our transaction: another settle on
 * this wallet (app, CLI, a second window) won the race. Nothing is lost, so the withdraw is skipped (Q0242).
 */
export function balanceGone(msg: string): boolean {
  return /BalanceZero|\(6023\)/i.test(msg);
}

/**
 * The VPN service went away while settle read its live sessions (Q0280: Windows shutting down mid-settle,
 * "ListSessions: Connection dropped"). Settle stops without closing anything (closing blind could cut a
 * live session) and runs again later: the next session end, Wallet, or dvpnd's own 10-min sweep. Expected,
 * so it is a warning, not an error in Diagnostics. Matches DaemonError ops on the daemon's read calls only.
 */
export function daemonWentAway(err: unknown): boolean {
  const e = err as { name?: string; kind?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === 'DaemonError' && (e.kind === 'unavailable' || e.kind === 'timeout')) return true;
  return /^(ListSessions|ListChannels): .*(Connection dropped|UNAVAILABLE|ECONNREFUSED|ECONNRESET|ENOENT|No connection established)/i.test(e.message ?? '');
}

export { formatCountdown } from '../../shared/format';
