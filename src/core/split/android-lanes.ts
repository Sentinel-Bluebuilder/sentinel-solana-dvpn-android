// ─── Android split tunnelling picture: which traffic goes which way (pure, unit-tested) ───
// Two lanes, through the VPN and the normal connection, from the SAVED split (vpn/Split.kt),
// allow-LAN (dvpnd) and the measured exit IPs. Every protocol applies the split on Android
// (VpnService allowed/disallowed apps + routes), so there is no "not applied" case here.

export type SplitMode = 'all' | 'include' | 'exclude';
export interface AndroidSplit { mode: SplitMode; packages: string[]; routeMode: SplitMode; routes: string[] }
export interface Lane { label: string; pkg?: string }
export interface AndroidLanes {
  live: boolean;
  vpn: Lane[];
  direct: Lane[];
  vpnExit: string | null;    // measured while connected (in-tunnel probe), else null
  directExit: string | null; // the phone's own IP, measured while not connected
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function androidLanes(o: {
  split: AndroidSplit;
  allowLan: boolean;
  live: boolean;
  vpnIp: string | null;
  homeIp: string | null;
  appName: (pkg: string) => string;
}): AndroidLanes {
  const s = o.split;
  const apps = s.packages.map((p) => ({ label: o.appName(p), pkg: p }));
  const vpn: Lane[] = [];
  const direct: Lane[] = [];
  if (s.mode === 'include') { vpn.push(...apps); direct.push({ label: 'Every other app' }); }
  else if (s.mode === 'exclude') { vpn.push({ label: 'Every other app' }); direct.push(...apps); }
  else vpn.push({ label: 'Every app' });

  // Addresses narrow what the VPN apps send (the DNS servers always stay inside).
  if (s.routeMode === 'include' && s.routes.length) {
    vpn.push({ label: `only to ${plural(s.routes.length, 'chosen address', 'chosen addresses')}` });
    direct.push({ label: 'Everything else those apps send' });
  } else if (s.routeMode === 'exclude' && s.routes.length) {
    direct.push({ label: plural(s.routes.length, 'address range') });
  }
  if (o.allowLan) direct.push({ label: 'Your local network (Allow local network)' });
  // Always true on Android: the app pays for sessions on its own connection (outside the VPN).
  direct.push({ label: 'This app, to pay nodes' });

  return { live: o.live, vpn, direct, vpnExit: o.live ? o.vpnIp : null, directExit: o.homeIp };
}
