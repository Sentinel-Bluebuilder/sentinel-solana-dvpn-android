// ─── Host names that can resolve ───

/** A DNS name or an IP (IPv6 in brackets, as URL.hostname gives it). WHATWG URL accepts hosts like
 *  `x"y`; nothing can serve them, so they are refused before they reach a setting or a config file. */
export function validHost(h: string): boolean {
  if (/^\[[0-9a-f:.]+\]$/i.test(h)) return true;
  return h.length > 0 && h.length <= 253 && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);
}
