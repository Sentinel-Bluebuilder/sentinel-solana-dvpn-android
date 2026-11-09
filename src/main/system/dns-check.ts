// ─── Is DNS really left over after a session? (F15, UPSTREAM-GAPS #25) ───
// dvpnd on Windows sets the VPN's DNS servers on the TUNNEL interface, and on stop removes
// the tunnel first and then runs `netsh … set dnsservers dhcp` on the interface that no
// longer exists. netsh fails, and the daemon reports dns_revert_failed although Windows
// DNS is fine (clean-VM run 2026-10-20). Before alarming the user, look: a real leftover is
// one of the VPN's DNS servers still set on a live, non-VPN adapter.
import { execFile } from 'node:child_process';
import { log } from '../logger';

export interface AdapterDns { alias: string; servers: string[] }

/** Pure decision, exported for tests. */
export function leftoverDns(adapters: AdapterDns[], vpnServers: string[]): AdapterDns[] {
  const ours = new Set(vpnServers.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!ours.size) return [];
  return adapters.filter((a) => !/^dvpn-/i.test(a.alias) && a.servers.some((s) => ours.has(s.toLowerCase())));
}

/** Parse `Get-DnsClientServerAddress | ConvertTo-Json` (object or array). Exported for tests. */
export function parseAdapterDns(json: string): AdapterDns[] {
  const raw = JSON.parse(json.replace(/^﻿/, '') || '[]') as unknown;
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<{ InterfaceAlias?: string; ServerAddresses?: string[] | string }>;
  return rows
    .filter((r) => r && r.InterfaceAlias)
    .map((r) => ({ alias: String(r.InterfaceAlias), servers: Array.isArray(r.ServerAddresses) ? r.ServerAddresses : r.ServerAddresses ? [r.ServerAddresses] : [] }));
}

function adapterDns(): Promise<AdapterDns[]> {
  const cmd = 'Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias, ServerAddresses | ConvertTo-Json -Compress';
  const env = { ...process.env };
  delete env.PSModulePath; // a PowerShell 7 parent breaks 5.1's module autoload
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15_000, windowsHide: true, env }, (err, stdout) => {
      if (err) { reject(err); return; }
      try { resolve(parseAdapterDns(String(stdout).trim())); } catch (parseErr) { reject(parseErr); }
    });
  });
}

/**
 * true = the VPN's DNS is still set somewhere (tell the user), false = the daemon's
 * report was a false alarm. Unknown (not Windows, no servers, check failed) = true.
 */
export async function dnsReallyLeftOver(vpnServers: string[] | undefined): Promise<boolean> {
  if (process.platform !== 'win32' || !vpnServers?.length) return true;
  try {
    const left = leftoverDns(await adapterDns(), vpnServers);
    if (left.length) log.warn('VPN DNS still set', { adapters: left.map((a) => a.alias) });
    else log.info('dns_revert_failed was a false alarm: no adapter keeps the VPN DNS');
    return left.length > 0;
  } catch (err) {
    log.warn('DNS leftover check failed', { err: (err as Error).message });
    return true;
  }
}

/**
 * Drop Windows' DNS cache after a tunnel comes up or goes down. Answers (and failures)
 * cached on the old path are wrong for the new one: a lookup made in the first second of a
 * session fails and stays failed for a while. Same as `ipconfig /flushdns`; needs no admin.
 * Fire and forget, logged.
 */
export function flushDnsCache(): void {
  if (process.platform !== 'win32') return;
  execFile('ipconfig.exe', ['/flushdns'], { timeout: 10_000, windowsHide: true }, (err) => {
    if (err) log.warn('flushing the DNS cache failed', { err: err.message });
  });
}
