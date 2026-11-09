// ─── What a connected session really covers (owner 2026-10-21: "it says connected, IP not changed") ───
// "Protected" is shown ONLY when the IP that apps use is the node's. V2Ray/Xray sessions are a
// SOCKS proxy: without the Windows system proxy nothing but proxy-configured apps uses them.
// A full tunnel whose direct exit IP is still the user's own IP is not protecting anything.

export type Coverage =
  | 'device'      // full tunnel, exit IP checked and not the user's own
  | 'proxy-apps'  // V2Ray/Xray + Windows system proxy: browsers and proxy-aware apps
  | 'proxy-only'  // V2Ray/Xray, system proxy off: only apps pointed at the SOCKS port
  | 'leaking'     // connected, but traffic still leaves with the user's own IP
  | 'unchecked'   // full tunnel, IP not measured yet (or IP checks turned off)
  | 'split-include' // split tunnelling: only the chosen apps/addresses use the VPN (by design)
  | 'split-exclude' // split tunnelling: everything but the left-out apps/addresses, exit checked
  | 'split-exclude-unconfirmed'; // exclude split, but this app's own IP check went direct (it may be left out)

export interface CoverageInput {
  proxyEndpoint: string;     // '' for full-tunnel protocols
  proxyActive: boolean;      // Windows system proxy points at our SOCKS endpoint
  directIp: string | null;   // exit IP of a normal (non-proxy) request, measured while connected
  proxyIp?: string | null;   // exit IP through the session's SOCKS proxy (V2Ray/Xray)
  homeIp: string | null;     // the user's own IP, measured while not connected
  nodeIp?: string | null;    // the node's own address: an exit IP equal to it is the VPN for sure
  /** Split tunnelling dvpnd applies to this session (splitNotApplied() === null), else null. */
  split?: 'include' | 'exclude' | null;
}

export function coverageOf(i: CoverageInput): Coverage {
  // Include: this app's own IP check is not a chosen app, so it SHOULD see the user's own IP.
  if (i.split === 'include') return 'split-include';
  const c = coverageWhole(i);
  if (i.split !== 'exclude') return c;
  // The IP check itself may be what was left out (its addresses or this app), so a home-IP
  // reading cannot tell a leak from the user's own choice: never "Protected", never "leaking".
  return c === 'device' ? 'split-exclude' : c === 'leaking' ? 'split-exclude-unconfirmed' : c;
}

function coverageWhole(i: CoverageInput): Coverage {
  if (i.proxyEndpoint) {
    // Xray whole-device mode (dvpnd rc, TUN adapter): a normal, non-proxy request already
    // leaves through the node, so every app is covered whatever the system proxy says.
    if (i.directIp && i.directIp === i.nodeIp) return 'device';
    if (i.directIp && i.homeIp && i.directIp !== i.homeIp && i.proxyIp && i.directIp === i.proxyIp) return 'device';
    if (!i.proxyActive) return 'proxy-only';
    // Browsers follow the system proxy; a direct request still exits by the user's own IP,
    // which is expected here (apps that ignore the proxy) and said in the copy. The proxy
    // itself must be proven to exit elsewhere first.
    if (i.proxyIp && i.proxyIp === i.nodeIp) return 'proxy-apps';
    if (!i.proxyIp || !i.homeIp) return 'unchecked';
    return i.proxyIp === i.homeIp ? 'leaking' : 'proxy-apps';
  }
  if (i.directIp && i.directIp === i.nodeIp) return 'device';
  if (!i.directIp || !i.homeIp) return 'unchecked';
  return i.directIp === i.homeIp ? 'leaking' : 'device';
}

export interface CoverageCopy {
  title: string;
  detail: string;
  /** True only when the user's traffic is covered as the title says. */
  ok: boolean;
}

/** Where the session applies: the device name, and on Android the per-app choice made at connect. */
export interface CoverageScope {
  place?: string;
  split?: { mode: 'all' | 'include' | 'exclude'; count: number; routeMode?: 'all' | 'include' | 'exclude'; routeCount?: number } | null;
}

function routesNote(scope: CoverageScope): string {
  const r = scope.split?.routeCount ?? 0;
  if (scope.split?.routeMode === 'include' && r > 0) return ` Only traffic to the ${r === 1 ? 'address' : `${r} addresses`} you chose uses the VPN.`;
  if (scope.split?.routeMode === 'exclude' && r > 0) return ` Traffic to the ${r === 1 ? 'address' : `${r} addresses`} you chose uses your normal connection.`;
  return '';
}

function deviceDetail(scope: CoverageScope, via: string): string {
  return appsDetail(scope, via) + routesNote(scope);
}

function appsDetail(scope: CoverageScope, via: string): string {
  const place = scope.place ?? 'this computer';
  const n = scope.split?.count ?? 0;
  if (scope.split?.mode === 'include' && n > 0) return `Only the ${n === 1 ? 'app' : `${n} apps`} you chose ${n === 1 ? 'goes' : 'go'} through the VPN; other apps use your normal connection.${via}`;
  if (scope.split?.mode === 'exclude' && n > 0) return `All apps on ${place} go through the VPN except the ${n === 1 ? 'one' : n} you chose.${via}`;
  return `All apps on ${place} go through the VPN.${via}`;
}

export function coverageCopy(c: Coverage, ip: { vpnIp?: string | null; homeIp?: string | null; checksOff?: boolean; scope?: CoverageScope } = {}): CoverageCopy {
  const via = ip.vpnIp ? ` Sites see ${ip.vpnIp}.` : '';
  switch (c) {
    case 'device':
      return { title: 'Protected', detail: deviceDetail(ip.scope ?? {}, via), ok: true };
    case 'proxy-apps':
      return {
        title: 'Protected in browsers',
        detail: `Browsers and apps that use the Windows proxy go through the VPN.${via} Apps that ignore the proxy (games, many command-line tools) use your normal connection.`,
        ok: true,
      };
    case 'proxy-only':
      return {
        title: 'Connected, not protecting this PC',
        detail: 'Only apps you point at the VPN proxy use it. Your browser and other apps still use your normal connection. Turn on "Send apps through the VPN" to cover them.',
        ok: false,
      };
    case 'leaking':
      return {
        title: 'Connected, but traffic is not going through the VPN',
        detail: `Sites still see your own IP${ip.homeIp ? ` ${ip.homeIp}` : ''}. Disconnect and try another server, or open Diagnostics.`,
        ok: false,
      };
    case 'split-include':
      return { title: 'Protected for the apps you chose', detail: 'Split tunnelling is on: the apps and addresses you chose go through the VPN. Everything else uses your normal connection.', ok: true };
    case 'split-exclude':
      return { title: 'Protected, except what you left out', detail: `Split tunnelling is on: everything goes through the VPN except the apps and addresses you left out.${via}`, ok: true };
    case 'split-exclude-unconfirmed':
      return { title: 'Connected, split tunnelling on', detail: `This app's IP check went out directly${ip.homeIp ? ` (${ip.homeIp})` : ''}, probably because its address or the app is on your left-out list, so it cannot confirm the VPN. Check from an app that uses the VPN, or open Diagnostics.`, ok: false };
    default:
      return ip.checksOff
        ? { title: 'Connected', detail: 'IP checks are off in Settings, so the app cannot confirm your traffic uses the VPN.', ok: false }
        : { title: 'Connected, checking your IP…', detail: 'Making sure sites see the server, not you.', ok: false };
  }
}
