// ─── Browser-safe formatting shared by renderer, main and CLI ───
// Nothing here may import web3.js, node: modules or the IDL.
import { tdvpn } from '../core/chain/amounts';
export { tdvpn, toBaseUnits, TOKEN_DECIMALS } from '../core/chain/amounts';
export { countryName, continentOf } from '../core/nodes/country';
export { closeReasonCopy, viewFor } from '../core/session/state';
export { costPreview, priceLabel, GB_OPTIONS, HOUR_OPTIONS, WIRE_OVERHEAD_NOTE } from '../core/pricing/cost';

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min` : `${s % 60} s`;
}

/** Balance for display: thousands separators; 2 decimals once the whole part reaches 1,000. Exact values stay in tdvpn(). */
export function formatTdvpn(baseUnits: string | bigint | number | null | undefined): string {
  const [whole, frac = ''] = tdvpn(baseUnits).split('.');
  const neg = whole.startsWith('-');
  const digits = neg ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const f = digits.length >= 4 ? frac.slice(0, 2).replace(/0+$/, '') : frac;
  return `${neg ? '-' : ''}${grouped}${f ? `.${f}` : ''}`;
}

export function formatBytes(n: string | number): string {
  let v = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

export function sol(lamports: number | string): string {
  return (Number(lamports) / 1e9).toFixed(4).replace(/\.?0+$/, '') || '0';
}

export const short = (s: string | null | undefined, n = 6): string => (!s ? '' : s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

/** "1 device", "2 devices". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A plan length in words: "1 day", "12 hours", "30 minutes" (never "24 h 0 min"). */
export function formatPeriod(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400 && s % 86400 === 0) return plural(s / 86400, 'day');
  if (s >= 3600) return s % 3600 === 0 ? plural(s / 3600, 'hour') : plural(Math.round(s / 3600), 'hour');
  return plural(Math.max(1, Math.round(s / 60)), 'minute');
}
