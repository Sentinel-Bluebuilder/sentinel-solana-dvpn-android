// ─── RPC key masking ───
// RPC URLs carry provider API keys in their query string: never show them on screen.
// A masked line that comes back unchanged maps to the stored URL (unmaskRpcUrls).

export const KEY_MASK = '••••';

export function maskRpcKey(url: string): string {
  return url.replace(/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, `$1${KEY_MASK}`);
}

/** Lines the user saved: a line still showing the mask means "unchanged", so the stored URL is used. */
export function unmaskRpcUrls(lines: string[], stored: string[]): string[] {
  return lines.map((u) => (u.includes(KEY_MASK) ? stored.find((o) => maskRpcKey(o) === u) ?? u : u));
}
