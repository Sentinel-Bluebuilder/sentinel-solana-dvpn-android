// Browser-safe: the Settings screen imports this directly.
// ─── DNS presets (F15). Handshake first: the mission default. ───
export const DNS_PRESETS: Record<string, { label: string; servers: string[] }> = {
  // Lookups go out from the server's network, and some networks block HNSDNS (gap #63: fails from
  // GCP, works from home ISPs; Cosmos lesson T15: 44 nodes at 0 speed). Kept first, said plainly.
  // Q0267: HNSDNS lost 25-90 % of queries from node networks (10-29); 1.1.1.1 third is the one
  // non-HNS fallback (when it is asked depends on the OS resolver).
  handshake: { label: 'Handshake (HNSDNS) - some servers block it', servers: ['103.196.38.38', '103.196.38.39', '1.1.1.1'] },
  cloudflare: { label: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { label: 'Google', servers: ['8.8.8.8', '8.8.4.4'] },
  quad9: { label: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
};

// ─── Saved lists from before a preset changed (Q0267) ───
const LEGACY_PRESETS: Record<string, string[]> = { handshake: ['103.196.38.38', '103.196.38.39'] };

/** A saved list equal to an older version of a preset becomes that preset's current list; anything else is returned unchanged. */
export function upgradeDnsServers(servers: string[] | undefined): string[] | undefined {
  const key = (servers ?? []).join(',');
  for (const [name, old] of Object.entries(LEGACY_PRESETS)) if (old.join(',') === key) return [...DNS_PRESETS[name].servers];
  return servers;
}

// ─── Settings DNS select (W-X64-UI-DNS-CUSTOM) ───
export const DNS_CUSTOM = 'custom';

/** Preset key whose servers equal `servers` (same order), else null. */
export function dnsPresetKey(servers: string[] | undefined): string | null {
  const key = (servers ?? []).join(',');
  return Object.entries(DNS_PRESETS).find(([, p]) => p.servers.join(',') === key)?.[0] ?? null;
}

/** Value the DNS select shows. Custom mode sticks even while the typed list happens to equal a preset. */
export function dnsSelectValue(servers: string[] | undefined, customMode: boolean): string {
  return customMode ? DNS_CUSTOM : dnsPresetKey(servers) ?? DNS_CUSTOM;
}

/** New state after the user picks `key` in the DNS select. Custom keeps the current servers to edit. */
export function dnsSelectChange(key: string, servers: string[] | undefined): { customMode: boolean; dnsServers: string[] } {
  const p = DNS_PRESETS[key];
  if (p) return { customMode: false, dnsServers: [...p.servers] };
  return { customMode: true, dnsServers: [...(servers ?? [])] };
}

/** Readable name for a resolver list: the preset it matches, else the addresses. */
export function dnsLabel(servers: string[] | undefined): string | null {
  if (!servers?.length) return null;
  const key = [...servers].sort().join(',');
  for (const p of Object.values(DNS_PRESETS)) if ([...p.servers].sort().join(',') === key) return p.label;
  return servers.join(', ');
}
