// ─── Pricing + cost preview (F8) ───
// Per-GB and per-hour are different products; never compare them on one axis.
// The escrow is the most the user can spend on one deposit; unused escrow comes
// back after settlement. Billing is on wire bytes (≈ +8 % on bulk downloads,
// more on small packets — sentinel-solana docs/18 §6a).
import { tdvpn } from '../chain/amounts';

export const GB_OPTIONS = [1, 2, 5, 10, 25, 50];
export const HOUR_OPTIONS = [1, 2, 4, 8, 12, 24];
export const PROTOCOL_FEE_BPS = 200;
export const WIRE_OVERHEAD_NOTE = 'Usage is measured on the wire, about 8–10% above what you download, more for small packets.';

export type Basis = 'per_gb' | 'per_hour';

export interface CostPreview {
  basis: Basis;
  units: number;
  unitPrice: string;     // base units per GB / per hour
  escrow: string;        // base units to lock
  escrowText: string;    // "1.5 tDVPN"
  feeText: string;       // protocol fee share of what is redeemed
  available: boolean;    // node offers this basis
}

export function costPreview(node: { pricePerGb: string; pricePerHour: string }, basis: Basis, units: number): CostPreview {
  const unitPrice = basis === 'per_gb' ? node.pricePerGb : node.pricePerHour;
  const available = BigInt(unitPrice || '0') > 0n;
  const escrow = (BigInt(unitPrice || '0') * BigInt(Math.max(1, Math.floor(units)))).toString();
  const fee = (BigInt(escrow) * BigInt(PROTOCOL_FEE_BPS)) / 10_000n;
  return {
    basis,
    units,
    unitPrice,
    escrow,
    escrowText: `${tdvpn(escrow)} tDVPN`,
    feeText: `Protocol fee: 2% of what you use (at most ${tdvpn(fee.toString())} tDVPN)`,
    available,
  };
}

export function priceLabel(baseUnits: string, basis: Basis): string {
  if (BigInt(baseUnits || '0') === 0n) return '—';
  return `${tdvpn(baseUnits)} tDVPN/${basis === 'per_gb' ? 'GB' : 'h'}`;
}

/** Below this the device cannot pay a new deposit account's rent plus fees. */
export const DEVICE_SOL_MIN = 5_000_000;

/** Can the wallet pay this escrow through the device? Returns the first blocker or null. */
export function fundingBlocker(p: { escrow: string; walletTdvpn: string; userBalance: string; delegated: string; allowance: string; deviceLamports: number }): string | null {
  const escrow = BigInt(p.escrow);
  const pool = BigInt(p.userBalance) + BigInt(p.walletTdvpn);
  if (pool < escrow) return `Not enough tDVPN: this deposit needs ${tdvpn(p.escrow)}.`;
  const shortfall = escrow > BigInt(p.userBalance) ? escrow - BigInt(p.userBalance) : 0n;
  if (shortfall > BigInt(p.delegated)) return 'Your spending approval is lower than this deposit. Raise it in Wallet → Device.';
  if (BigInt(p.allowance) < escrow) return "This device's spending limit is lower than this deposit. Raise it in Wallet → Device.";
  // The device pays the channel account rent (~0.003 SOL, returned on close) plus fees.
  if (p.deviceLamports < DEVICE_SOL_MIN) return 'This device needs a little SOL (0.005) for network fees and the deposit account. Top it up in Wallet → Device.';
  return null;
}
