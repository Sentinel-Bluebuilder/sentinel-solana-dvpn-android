// ─── Prepay caps ───
// dvpnd (cf4c 19f2f8b, Q0338) caps the prepaid block at max_prepay_bytes 256 MiB and
// max_prepay_seconds 15 min by default. The client signs one block ahead, so the cap bounds what a
// node can redeem for data it never delivered. A larger prepay_* is capped by dvpnd without a
// word; the app says so instead (Settings hint, one log line on apply).

export const PREPAY_CAP_BYTES = 256n * 1024n * 1024n;
export const PREPAY_CAP_SECONDS = 900n;

/** Which configured prepay values dvpnd will cap; empty when none. */
export function prepayOverCap(bytes?: string | null, seconds?: string | null): Array<'bytes' | 'seconds'> {
  const n = (v: string | null | undefined): bigint => { try { return v ? BigInt(v) : 0n; } catch (err) { console.warn('prepay value is not a whole number', v, err); return 0n; } };
  const out: Array<'bytes' | 'seconds'> = [];
  if (n(bytes) > PREPAY_CAP_BYTES) out.push('bytes');
  if (n(seconds) > PREPAY_CAP_SECONDS) out.push('seconds');
  return out;
}

/** The Settings hint for the prepay row. */
export function prepayHint(bytes?: string | null, seconds?: string | null): string {
  const base = 'Paid to the node when a session starts. A reused deposit must still cover it.';
  const cap = 'Max 268 MB and 15 min; larger values are capped to protect you.';
  return prepayOverCap(bytes, seconds).length ? `${base} ${cap}` : `${base} Max 268 MB and 15 min.`;
}
