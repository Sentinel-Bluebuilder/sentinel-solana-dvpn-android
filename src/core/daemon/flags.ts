// ─── `daemon set` flag values -> config.toml units (same units as the Settings screen) ───
import { toBaseUnits } from '../chain/amounts';

export class FlagError extends Error {}

/** --escrow in tDVPN -> base units. */
export function escrowFlag(v: string): string {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(v) || Number(v) <= 0) throw new FlagError('--escrow must be a positive tDVPN amount, e.g. 2.5');
  return toBaseUnits(v);
}

/** A whole number of MB / minutes -> bytes / seconds. 0 = back to the node's minimum (the Android app: refusing it left no way back). */
export function wholeFlag(name: string, v: string, unit: bigint): string {
  if (!/^\d{1,9}$/.test(v)) throw new FlagError(`--${name} must be a whole number (0 = the node's minimum)`);
  return (BigInt(v) * unit).toString();
}

/** A true|false flag: anything else is a usage error (never silently false). */
export function boolFlag(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new FlagError(`--${name} must be true or false, got "${raw}"`);
}
