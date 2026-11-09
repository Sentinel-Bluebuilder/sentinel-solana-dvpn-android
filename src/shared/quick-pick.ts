// ─── Quick connect pick: favourite → preferred country → lowest latency, online only ───
// Shared by the Connect screen and connect-on-launch so both choose the same server.
import type { NodeView } from './types';

export function pickQuickNode(nodes: NodeView[], preferredCountry: string | null): NodeView | null {
  const online = nodes.filter((n) => n.probe?.ok);
  const fav = online.filter((n) => n.favourite);
  const pref = preferredCountry ? online.filter((n) => n.countryCode === preferredCountry) : [];
  const pool = fav.length ? fav : pref.length ? pref : online;
  return [...pool].sort((a, b) => (a.probe?.latencyMs ?? 9e9) - (b.probe?.latencyMs ?? 9e9))[0] ?? null;
}
