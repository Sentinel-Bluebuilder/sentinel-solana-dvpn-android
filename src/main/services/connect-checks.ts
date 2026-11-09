// ─── Connect checks and lookups (split from connection.ts) ───
// Zero-cost checks before paying, and the daemon/chain lookups that decide whether to reuse a
// deposit or ticket. Nothing here pays or changes the network.
import type { ConnectRequest } from '../../shared/types';
import { PREPAY_CAP_BYTES, PREPAY_CAP_SECONDS } from '../../shared/prepay-cap';
import { killSwitchBlocksProtocol } from '../../core/session/state';
import { discoverNode, probeNode } from '../../core/nodes/discovery';
import { costPreview, fundingBlocker } from '../../core/pricing/cost';
import { readWalletStatus } from '../../core/app/wallet-status';
import { CHANNEL_STATUS_OPEN, MODE_STREAM } from '../../core/chain/idl';
import { streamLeft, type StreamFields } from '../../core/settlement/settlement';
import { daemon, daemonInfo } from '../daemon/manager';
import { ownerAddress } from '../wallet/vault';
import { channelsByOwner } from '../../core/chain/accounts';
import { subscriptionsOf } from '../../core/plans/plans';
import { patch, snapshot } from '../app-state';
import { log } from '../logger';
import { getDaemonSettings } from '../daemon/settings';
import { topUpDeviceIfLow } from './device-topup';
import { openvpnAdapterMissing, recreateOpenvpnAdapter } from '../system/drivers';

/** The daemon prepays this much up front (client config prepay_bytes / prepay_seconds; defaults 1 GB / 1 h). */
export function prepayCost(node: { pricePerGb: string; pricePerHour: string }, basis: 'per_gb' | 'per_hour'): bigint {
  const cfg = getDaemonSettings().settings;
  return prepayFor(node, basis, cfg.prepayBytes, cfg.prepaySeconds);
}

/**
 * Pure part of prepayCost. A configured 0 (what `dvpnd init` writes) means "the node's minimum
 * block", NOT "nothing": reading it as 0 let a fully spent per-hour deposit pass the reuse check,
 * and the node closed every such session at once with "credit exhausted" (test-host mx182, all six
 * protocols). The node minimum is not known here, so 0 counts as a TENTH of the default block
 * (100 MB / 6 min). Not the whole block: a per-GB deposit is exactly one 1 GB block and the node
 * takes its first 100 MB block at connect, so "a full GB left" refused every per-GB reuse and each
 * reconnect paid a new deposit + rent (ui-win-2 adopt 2026-10-22: 0.0009 left of 0.001). The tenth
 * matches what the node itself takes when asked for 0: 100 MB / 6 min (no chain field for it).
 * Proven: ui-win-2 uiextra-adopt186, second connect reused the deposit. A spent deposit (0 left)
 * still fails. Never below 1.
 */
export function prepayFor(node: { pricePerGb: string; pricePerHour: string }, basis: 'per_gb' | 'per_hour', bytes?: string | null, seconds?: string | null): bigint {
  const pick = (v: string | null | undefined, dflt: bigint, cap: bigint): bigint => { const n = v == null || v === '' ? 0n : BigInt(v); return n > 0n ? (n < cap ? n : cap) : dflt; };
  // Q0338: dvpnd never prepays more than its cap, so neither does this estimate.
  const cost = basis === 'per_gb'
    ? (pick(bytes, 100_000_000n, PREPAY_CAP_BYTES) * BigInt(node.pricePerGb) + 999_999_999n) / 1_000_000_000n
    : (pick(seconds, 360n, PREPAY_CAP_SECONDS) * BigInt(node.pricePerHour) + 3599n) / 3600n;
  return cost > 0n ? cost : 1n;
}

/** Zero-cost checks; returns the first blocker. */
export async function preflight(req: ConnectRequest, owner: string, device: string): Promise<{ error: string; action?: string } | null> {
  if (snapshot().session && !req.switch) return { error: 'Disconnect the current session first.' };
  const node = await discoverNode(req.node);
  if (!node) return { error: 'That server is not on the network any more.' };
  if (!node.listingFresh) return { error: 'That server has not checked in recently. Pick another.' };
  const probe = await probeNode(node);
  if (!probe.ok) return { error: `${probe.error ?? 'Server check failed'}. Nothing was paid.`, action: 'Pick another server' };
  const blocked = killSwitchBlocksProtocol(process.platform, getDaemonSettings().settings.killSwitch, probe.serviceType, daemonInfo().version);
  if (blocked) return { error: blocked, action: 'Open settings' };
  if (probe.serviceType === 'openvpn' && await openvpnAdapterMissing()) {
    // An AmneziaWG session removes it (gap #27): put it back ourselves instead of refusing.
    const fixed = await recreateOpenvpnAdapter();
    if (!fixed.ok) {
      return { error: `The OpenVPN network adapter is missing and could not be added back (${fixed.detail}). Repair drivers, then connect again. Nothing was paid.`, action: 'Open diagnostics' };
    }
  }
  if (req.subscription) return null; // plan access: the provider pays the node, no escrow
  const cost = costPreview(node, req.basis, req.units);
  if (!cost.available) return { error: `This server does not sell ${req.basis === 'per_gb' ? 'per GB' : 'per hour'}.` };
  let w = await readWalletStatus(owner, device);
  if ((await topUpDeviceIfLow(w, device)).done) w = await readWalletStatus(owner, device);
  patch({ wallet: w });
  const blocker = fundingBlocker({
    escrow: cost.escrow, walletTdvpn: w.ownerTdvpn, userBalance: w.userBalance, delegated: w.delegated,
    allowance: w.grant?.allowance ?? '0', deviceLamports: w.deviceLamports,
  });
  return blocker ? { error: blocker, action: 'Open Wallet' } : null;
}

/** An open channel the daemon already has with this node, reused instead of paying again (F9.3).
 *  Only when what is left covers the daemon's up-front prepay (`minLeft`), or StartSession refuses it. */
export async function reusableChannel(node: string, mode: number, minLeft: bigint): Promise<string | null> {
  try {
    const chans = await daemon().listChannels();
    // The daemon's escrow is a copy from when it opened the channel; a top-up (fund_channels) only
    // shows on chain. dvpnd reloads it from chain when it resumes the channel, so judge by chain.
    const owner = ownerAddress();
    if (!owner) return null;
    // Only channels still OPEN on chain: the daemon keeps listing ones the app has since closed.
    const onChain = new Map<string, StreamFields>();
    for (const c of await channelsByOwner(owner)) {
      if (Number(c.status) === CHANNEL_STATUS_OPEN) {
        onChain.set(String(c.address), { escrow: String(c.escrow ?? '0'), ratePerHour: String(c.ratePerHour ?? '0'), streamBase: String(c.streamBase ?? '0'), streamStartedAt: String(c.streamStartedAt ?? '0') });
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const c = chans.find((ch) => {
      const chain = onChain.get(ch.address);
      if (chain === undefined || ch.node !== node || Number(ch.mode) !== mode) return false;
      // Per hour: the node charges wall-clock time since the stream started, not traffic, so an
      // old channel can be spent even if the daemon's voucher total is small ("credit exhausted").
      if (mode === MODE_STREAM) return streamLeft(chain, now) >= minLeft;
      const chainEscrow = BigInt(chain.escrow);
      const escrow = chainEscrow > BigInt(ch.escrow) ? chainEscrow : BigInt(ch.escrow);
      return escrow - BigInt(ch.cumulative || '0') >= minLeft;
    });
    return c?.address ?? null;
  } catch (err) {
    log.warn('listChannels failed; opening a new channel', { err: (err as Error).message });
    return null;
  }
}

/** The plan's device limit counts unexpired tickets; null when another ticket can still be issued. */
export async function planLimitReached(subscription: string): Promise<{ max: number; used: string[] } | null> {
  try {
    const owner = ownerAddress();
    if (!owner) return null;
    const sub = (await subscriptionsOf(owner)).find((x) => x.address === subscription);
    if (!sub || !sub.maxConnections) return null;
    const now = Math.floor(Date.now() / 1000);
    const used = [...new Set((await daemon().listTickets()).filter((t) => t.subscription === subscription && Number(t.expiresAt) > now).map((t) => t.node))];
    return used.length >= sub.maxConnections ? { max: sub.maxConnections, used } : null;
  } catch (err) {
    log.warn('plan limit check failed; asking the provider', { err: (err as Error).message });
    return null;
  }
}

/** An unexpired ticket the daemon holds for this subscription and node (hash), if any. */
export async function heldTicket(subscription: string, node: string): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const t = (await daemon().listTickets()).find((x) => x.subscription === subscription && x.node === node && Number(x.expiresAt) > now + 60);
    return t?.hash ?? null;
  } catch (err) {
    log.warn('listTickets failed; requesting a new ticket', { err: (err as Error).message });
    return null;
  }
}

export async function nodeHasRoom(address: string): Promise<boolean> {
  try {
    const n = await discoverNode(address);
    if (!n) return false;
    const pr = await probeNode(n);
    return pr.peers !== null && pr.maxPeers !== null && pr.peers < pr.maxPeers;
  } catch (err) {
    log.warn('node probe failed; not paying a second deposit', { node: address, err: (err as Error).message });
    return false;
  }
}
