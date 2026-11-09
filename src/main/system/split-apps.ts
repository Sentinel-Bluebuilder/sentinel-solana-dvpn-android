// ─── Per-app split tunnelling (Android) ───
// Which apps go through the VPN, for all six protocols (the VpnService builder's allowed /
// disallowed apps). Kept by the Kotlin shell (vpn/Split.kt) and read at every establish, so a
// change applies from the next connect or server switch. This app itself is never inside the
// VPN (ANDROID-PORT D-A2). On the desktop, apps are chosen with the proxy (V2Ray/Xray) instead.
import { bridgeCall, isAndroid } from '../platform/android-bridge';

export type SplitMode = 'all' | 'include' | 'exclude';
export const SPLIT_MODES: SplitMode[] = ['all', 'include', 'exclude'];
export interface SplitState { mode: SplitMode; packages: string[]; routeMode: SplitMode; routes: string[] }
export interface AppEntry { pkg: string; label: string; system: boolean; icon?: string }
/** A PNG drawn by the app shell: base64 only, small (48 px), else dropped. */
const ICON = /^[A-Za-z0-9+/]+={0,2}$/;
export function iconOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length < 40_000 && ICON.test(v) && v.startsWith('iVBORw0KGgo') ? v : undefined;
}

export const SPLIT_DESKTOP = 'Choosing apps by name is in the Android app. On this computer, a V2Ray or Xray session sends chosen apps through the VPN with the proxy (proxy on, proxy browser).';
const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_PACKAGES = 500;
const MAX_ROUTES = 200;
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isV6(ip: string): boolean {
  if (!ip.includes(':') || ip.split('::').length > 2) return false;
  const groups = ip.split(':');
  if (groups.length > 8) return false;
  return groups.every((g) => /^[0-9a-f]{0,4}$/i.test(g)) && (ip.includes('::') || groups.length === 8);
}

/** One address or network for split by destination: "1.2.3.4", "10.0.0.0/8", "2001:db8::/32". */
export function validRoute(s: string): boolean {
  const [ip, bits, extra] = s.trim().split('/');
  if (extra !== undefined || !ip) return false;
  const v4 = V4.test(ip);
  if (!v4 && !isV6(ip)) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v4 ? 32 : 128);
}

/** Checks a split-by-destination choice; returns it normalised (trimmed, unique, sorted). */
export function validateRoutes(mode: string, routes: string[]): { routeMode: SplitMode; routes: string[] } {
  if (!SPLIT_MODES.includes(mode as SplitMode)) throw new Error(`Split mode must be one of ${SPLIT_MODES.join(', ')}.`);
  const list = [...new Set(routes.flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean))].sort();
  const bad = list.filter((r) => !validRoute(r));
  if (bad.length) throw new Error(`Not an IP address or network (like 10.0.0.0/8): ${bad.slice(0, 3).join(', ')}`);
  if (list.length > MAX_ROUTES) throw new Error(`At most ${MAX_ROUTES} addresses.`);
  if (mode === 'include' && !list.length) throw new Error('"Only these addresses" needs at least one address; otherwise everything would use the VPN.');
  return { routeMode: mode as SplitMode, routes: mode === 'all' ? [] : list };
}

function androidOnly(): void {
  if (!isAndroid()) throw new Error(SPLIT_DESKTOP);
}

async function bridge(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await bridgeCall(req);
  if (!r.ok) throw new Error(r.error ?? `app bridge ${String(req.op)} failed`);
  return r;
}

/** Checks a split choice; returns it normalised (sorted, unique). Throws with a plain message. */
export function validateSplit(mode: string, packages: string[]): SplitState {
  if (!SPLIT_MODES.includes(mode as SplitMode)) throw new Error(`Split mode must be one of ${SPLIT_MODES.join(', ')}.`);
  const bad = packages.filter((p) => !PKG.test(p));
  if (bad.length) throw new Error(`Not an Android package name: ${bad.slice(0, 3).join(', ')}`);
  const list = [...new Set(packages)].sort();
  if (list.length > MAX_PACKAGES) throw new Error(`At most ${MAX_PACKAGES} apps.`);
  if (mode === 'include' && !list.length) throw new Error('"Only these apps" needs at least one app; otherwise every app would use the VPN.');
  return { mode: mode as SplitMode, packages: mode === 'all' ? [] : list, routeMode: 'all', routes: [] };
}

export async function splitGet(): Promise<SplitState> {
  androidOnly();
  const r = await bridge({ op: 'splitGet' });
  const apps = validateSplit(String(r.mode ?? 'all'), Array.isArray(r.packages) ? r.packages.map(String) : []);
  return { ...apps, ...validateRoutes(String(r.routeMode ?? 'all'), Array.isArray(r.routes) ? r.routes.map(String) : []) };
}

export async function splitSet(mode: string, packages: string[]): Promise<SplitState> {
  androidOnly();
  const s = validateSplit(mode, packages);
  await bridge({ op: 'splitSet', mode: s.mode, packages: s.packages });
  return splitGet();
}

/** Split by destination: which addresses use the VPN (all / only these / all except these). */
export async function splitRoutesSet(mode: string, routes: string[]): Promise<SplitState> {
  androidOnly();
  const r = validateRoutes(mode, routes);
  await bridge({ op: 'splitRoutesSet', mode: r.routeMode, routes: r.routes });
  return splitGet();
}

/** Launchable apps on the phone (label order), this app left out. */
export async function splitApps(): Promise<AppEntry[]> {
  androidOnly();
  const r = await bridge({ op: 'apps' });
  const list = Array.isArray(r.apps) ? r.apps : [];
  return list
    .map((a) => a as Record<string, unknown>)
    .filter((a) => typeof a.pkg === 'string' && PKG.test(a.pkg))
    .map((a) => ({ pkg: String(a.pkg), label: String(a.label ?? a.pkg), system: a.system === true, icon: iconOf(a.icon) }))
    .sort((x, y) => x.label.localeCompare(y.label));
}
