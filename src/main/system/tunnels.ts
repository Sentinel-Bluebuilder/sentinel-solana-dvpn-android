// ─── Leftover tunnel services (F14.3, UPSTREAM-GAPS #24 / #29) ───
// dvpnd can abandon a session and leave its Windows tunnel service running: the WireGuard
// (or AmneziaWG) service keeps the default route, so the computer is offline with no session
// to stop. "Restore network" removes such services; it never touches a user's own tunnels.
import { execFile } from 'node:child_process';
import { log } from '../logger';
import { runElevated } from './elevate';
import { scriptPath } from '../daemon/manager';

const OURS = /^(WireGuardTunnel|AmneziaWGTunnel)\$dvpn-/i;

/** Parse `sc.exe query state= all`: running services whose name is one of our tunnels. Exported for tests. */
export function parseTunnelServices(scOutput: string): string[] {
  const out: string[] = [];
  for (const block of scOutput.split(/\r?\n\s*\r?\n/)) {
    const name = /SERVICE_NAME:\s*(\S+)/.exec(block)?.[1];
    if (name && OURS.test(name) && /STATE\s*:\s*\d+\s+(RUNNING|START_PENDING)/.test(block)) out.push(name);
  }
  return out;
}

/** Our tunnel services that are running now (unelevated; [] off Windows or when sc fails). */
export function runningTunnelServices(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('sc.exe', ['query', 'state=', 'all'], { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { log.warn('sc query failed; cannot look for leftover tunnels', { err: err.message }); resolve([]); return; }
      resolve(parseTunnelServices(String(stdout)));
    });
  });
}

/** Remove our leftover tunnel services and orphaned protocol processes (one administrator prompt). Call only with no live session. */
export async function removeTunnelServices(): Promise<{ ok: boolean; detail: string }> {
  const r = await runElevated(scriptPath('remove-tunnels.ps1'), {}, 120_000);
  log.info('leftover tunnels', { status: r.status, detail: r.detail });
  return { ok: r.status === 'ok', detail: r.detail };
}

// ─── Orphaned protocol processes (UPSTREAM-GAPS the Linux app) ───
// When dvpnd dies, its hysteria2 / v2ray / xray child keeps running and keeps the tunnel (and,
// for per-hour channels, the bill) going, while the kill-switch filters die with dvpnd. These
// names are only ever run from the app's own folder; the elevated step checks the path again.
const ORPHAN_NAMES = /^(hysteria2|v2ray|xray)\.exe$/i;

/** Parse `tasklist /FO CSV /NH`: our protocol process names that are running. Exported for tests. */
export function parseOrphanProcesses(csv: string): string[] {
  const out: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const name = /^"([^"]+)","(\d+)"/.exec(line);
    if (name && ORPHAN_NAMES.test(name[1])) out.push(`${name[1]}:${name[2]}`);
  }
  return out;
}

/** Our protocol processes running now (unelevated; names only). */
export function runningProtocolProcesses(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { log.warn('tasklist failed; cannot look for orphaned protocol processes', { err: err.message }); resolve([]); return; }
      resolve(parseOrphanProcesses(String(stdout)));
    });
  });
}

// ─── Another VPN holding the default route (Cosmos lesson D6) ───
// Two VPNs fight over the same traffic: routes conflict and the second tunnel often carries
// nothing. A VPN shows up as the classic 0.0.0.0/1 + 128.0.0.0/1 pair, or as the default route on
// a virtual VPN adapter. Our own adapters are skipped. "OpenVPN Wintun" is also what a user's own
// OpenVPN 2.6 may call its adapter; it counts as ours (a missed warning, never a false one).
// "OpenVPN Data Channel Offload" is dvpnd's OpenVPN adapter on ARM64 (UPSTREAM-GAPS #83).
const OUR_ADAPTERS = /^(dvpn-|hy2-client$|OpenVPN Wintun$|OpenVPN Data Channel Offload$)/i;
const VPN_ADAPTER = /wireguard|wintun|tap-windows|openvpn|nordlynx|proton|mullvad|expressvpn|surfshark|windscribe|cisco anyconnect|fortinet|globalprotect|pangp|zscaler|\bvpn\b|tunnel/i;

/** Parse lines `alias|prefix|physical 0/1|adapter description`: other VPNs' adapter names. Exported for tests. */
export function parseRivalRoutes(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const [alias, prefix, phys, desc = ''] = line.trim().split('|');
    if (!alias || !prefix || OUR_ADAPTERS.test(alias)) continue;
    const half = prefix === '0.0.0.0/1' || prefix === '128.0.0.0/1';
    const vpnDefault = prefix === '0.0.0.0/0' && phys === '0' && VPN_ADAPTER.test(`${alias} ${desc}`);
    if (half || vpnDefault) out.add(alias);
  }
  return [...out];
}

const RIVAL_PS = [
  "$phys = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })",
  "Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0','0.0.0.0/1','128.0.0.0/1' } | ForEach-Object {",
  "  $a = Get-NetAdapter -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue",
  "  '{0}|{1}|{2}|{3}' -f $_.InterfaceAlias, $_.DestinationPrefix, [int]($phys -contains $_.InterfaceAlias), $a.InterfaceDescription }",
].join('\n');

/** Other VPNs holding the default route now (unelevated; [] off Windows or when the query fails). */
export function rivalVpns(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RIVAL_PS], { timeout: 20_000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) { log.warn('route query failed; cannot look for another VPN', { err: err.message }); resolve([]); return; }
      resolve(parseRivalRoutes(String(stdout)));
    });
  });
}

/** Doctor row: ok when no other VPN holds the default route, warn with plain copy when one does. */
export async function rivalVpnRow(): Promise<{ name: string; ok: boolean; level: 'ok' | 'warn'; detail: string }> {
  const rivals = await rivalVpns();
  if (rivals.length === 0) return { name: 'other_vpn', ok: true, level: 'ok', detail: 'No other VPN is active.' };
  return {
    name: 'other_vpn', ok: true, level: 'warn',
    detail: `Another VPN is on (${rivals.join(', ')}). Turn it off before you connect: two VPNs fight over the same traffic and yours may carry nothing.`,
  };
}

/** Everything a dead or failed session can leave holding the network: tunnel services + protocol processes. */
export async function leftoverTunnels(): Promise<string[]> {
  const [svc, proc] = await Promise.all([runningTunnelServices(), runningProtocolProcesses()]);
  return [...svc, ...proc];
}
