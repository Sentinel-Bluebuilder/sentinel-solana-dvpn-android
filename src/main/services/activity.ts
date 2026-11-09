// ─── Activity (F7.6, F8.7, F13.1–F13.4) ───
// Daemon-side sessions / channels / tickets, the spend summary, recent servers,
// and topping up a deposit that is still open with a server.
import type { Result } from '../../shared/types';
import type { DaemonChannel, DaemonTicket } from '../../core/daemon/client';
import { channelByPda, channelsByOwner } from '../../core/chain/accounts';
import { fundChannels } from '../../core/chain/builders';
import { CHANNEL_STATUS_CLOSING, CHANNEL_STATUS_OPEN } from '../../core/chain/idl';
import { toBaseUnits } from '../../core/chain/amounts';
import { signAndSend } from '../../core/app/signer';
import { describeInstructionError } from '../../core/chain/errors';
import { daemon, daemonInfo } from '../daemon/manager';
import { ownerAddress, ownerSigner } from '../wallet/vault';
import { listHistory } from './history';
import { toLive } from './connection';
import { refreshWallet } from './wallet';
import type { LiveSession } from '../../shared/types';
import { log } from '../logger';

export interface DaemonLists { sessions: LiveSession[]; channels: DaemonChannel[]; tickets: DaemonTicket[]; error: string | null }

/**
 * dvpnd keeps listing a deposit as "open" after the app has started closing it (settlement), so a
 * top-up of it was offered and then refused (VM sweep 2026-10-21). Show the chain's status and
 * escrow instead; a deposit whose account is gone is "closed". Falls back to dvpnd's view.
 */
export async function withChainStatus(chans: DaemonChannel[]): Promise<DaemonChannel[]> {
  const owner = ownerAddress();
  if (!owner || chans.length === 0) return chans;
  try {
    const onChain = new Map((await channelsByOwner(owner)).map((c) => [String(c.address), c]));
    return chans.map((c) => {
      const ch = onChain.get(c.address);
      if (!ch) return { ...c, status: 'closed' };
      const s = Number(ch.status);
      const status = s === CHANNEL_STATUS_OPEN ? 'open' : s === CHANNEL_STATUS_CLOSING ? 'closing' : c.status;
      const escrow = BigInt(String(ch.escrow ?? '0')) > BigInt(c.escrow || '0') ? String(ch.escrow) : c.escrow;
      // dvpnd cf4c372 lists deposits opened by the older build with node "" and mode 0 (seen by the Linux app).
      const node = c.node || (ch.node ? String(ch.node) : '');
      const mode = Number(c.mode) || Number(ch.mode) || 0;
      return { ...c, status, escrow, node, mode };
    });
  } catch (err) {
    log.warn('chain status of deposits unavailable; showing the VPN service view', { err: (err as Error).message });
    return chans;
  }
}

export async function daemonLists(): Promise<DaemonLists> {
  if (!daemonInfo().reachable) return { sessions: [], channels: [], tickets: [], error: 'The VPN service is not running.' };
  try {
    const [sessions, raw, tickets] = await Promise.all([daemon().listSessions(), daemon().listChannels(), daemon().listTickets()]);
    const channels = await withChainStatus(raw);
    return { sessions: sessions.map(toLive), channels, tickets, error: null };
  } catch (err) {
    log.warn('daemon lists failed', { err: (err as Error).message });
    return { sessions: [], channels: [], tickets: [], error: (err as Error).message };
  }
}

export interface SpendSummary { sessions: number; spent: string; bytes: string; last30Spent: string; byNode: Array<{ node: string; country: string; sessions: number; spent: string }> }

export function spendSummary(now = Date.now()): SpendSummary {
  const h = listHistory();
  const cutoff = now - 30 * 86_400_000;
  const by = new Map<string, { node: string; country: string; sessions: number; spent: bigint }>();
  let spent = 0n; let bytes = 0n; let last30 = 0n;
  for (const e of h) {
    const s = BigInt(e.spent || '0');
    spent += s;
    bytes += BigInt(e.rxBytes || '0') + BigInt(e.txBytes || '0');
    if (e.startedAt >= cutoff) last30 += s;
    const row = by.get(e.node) ?? { node: e.node, country: e.country, sessions: 0, spent: 0n };
    row.sessions += 1; row.spent += s;
    by.set(e.node, row);
  }
  return {
    sessions: h.length, spent: spent.toString(), bytes: bytes.toString(), last30Spent: last30.toString(),
    byNode: [...by.values()].sort((a, b) => (b.spent > a.spent ? 1 : -1)).slice(0, 10).map((r) => ({ ...r, spent: r.spent.toString() })),
  };
}

/** Servers used most recently, newest first (F7.6). */
export function recentNodes(limit = 8): string[] {
  const seen: string[] = [];
  for (const e of [...listHistory()].sort((a, b) => b.startedAt - a.startedAt)) {
    if (!seen.includes(e.node)) seen.push(e.node);
    if (seen.length >= limit) break;
  }
  return seen;
}

/** Add tDVPN to a deposit that is still open (F8.7) so a session can keep using it. */
export async function fundChannel(channel: string, amountTdvpn: string): Promise<Result<string>> {
  const owner = ownerAddress();
  if (!owner) return { ok: false, error: 'Set up a wallet first.', code: 'no-wallet' };
  let amount: string;
  try { amount = toBaseUnits(amountTdvpn); } catch (err) { return { ok: false, error: (err as Error).message, code: 'invalid-amount' }; }
  if (BigInt(amount) <= 0n) return { ok: false, error: 'Enter an amount.', code: 'invalid-amount' };
  // Read the one channel: a by-owner list can lag behind a channel opened seconds ago.
  const mine = await channelByPda(channel);
  if (!mine) return { ok: false, error: 'That deposit was not found on the network (it may already be closed).', code: 'not-found' };
  if (String(mine.owner) !== owner) return { ok: false, error: 'That deposit is not yours.', code: 'not-owner' };
  if (Number(mine.status) !== CHANNEL_STATUS_OPEN) return { ok: false, error: 'That deposit is closing; it cannot be topped up.', code: 'not-open' };
  try {
    const r = await signAndSend(ownerSigner(), [await fundChannels({ owner, channels: [{ address: channel, amount }] })], 'fund_channels');
    await refreshWallet();
    return { ok: true, data: r.signature };
  } catch (err) {
    return { ok: false, error: describeInstructionError(err) ?? (err as Error).message, code: 'fund-failed' };
  }
}
