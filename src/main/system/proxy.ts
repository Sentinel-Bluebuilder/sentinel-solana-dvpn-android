// ─── Windows system proxy for per-app split (F16a) ───
// Current user, unelevated. The user's previous proxy is saved to disk BEFORE we change it, so
// a crash is undone on the next start (restoreProxyOnStartup). Only V2Ray/Xray sessions expose
// a SOCKS endpoint.
// Set through WinINET per-connection options (resources/scripts/sysproxy.ps1), not by writing
// ProxyEnable/ProxyServer: browsers read the per-connection blob, and with only those two
// values Edge kept going direct (VM matrix 2026-10-21). Saving all four values (mode flags,
// server, bypass list, PAC URL) also brings back a user's auto-detect or PAC setup exactly.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readJson, writeJson, storePath } from '../store';
import { log } from '../logger';
import { patch } from '../app-state';
import { checkSocks5 } from '../../core/quality/socks-check';
import { scriptPath } from '../daemon/manager';
import { isAndroid } from '../platform/android-bridge';

const BACKUP = 'proxy-backup.json';

/** WinINET per-connection proxy settings. flags: 1 direct, 2 proxy, 4 PAC URL, 8 auto-detect. */
export interface ProxyState { flags: number; server: string; bypass: string; pac: string }
export const PROXY_DIRECT = 1;
export const PROXY_MANUAL = 2;

/** On disk. Backups written before 2026-10-21 hold the registry form (proxyEnable/proxyServer). */
interface Saved { state?: ProxyState; proxyEnable?: number; proxyServer?: string | null; ours: string }

export interface ProxyRunner { query(): Promise<ProxyState>; set(s: ProxyState): Promise<ProxyState> }

function runScript(args: string[]): Promise<ProxyState> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('sysproxy.ps1'), ...args],
      { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`system proxy helper failed: ${String(stderr).trim().split('\n')[0] || err.message}`));
        try { resolve(parseState(String(stdout))); } catch (e) { reject(e); }
      });
  });
}

/** The helper's last JSON line. Exported for tests. */
export function parseState(out: string): ProxyState {
  const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(`system proxy helper printed no state: ${out.slice(0, 120)}`); // copy:internal
  const v = JSON.parse(line) as Partial<ProxyState>;
  return { flags: Number(v.flags) || PROXY_DIRECT, server: v.server ?? '', bypass: v.bypass ?? '', pac: v.pac ?? '' };
}

let runner: ProxyRunner = {
  query: () => runScript(['-Mode', 'query']),
  set: (s) => runScript(['-Mode', 'set', '-Json', Buffer.from(JSON.stringify(s), 'utf8').toString('base64')]),
};

/** Tests only: never touch the real proxy settings. */
export function setProxyRunner(r: ProxyRunner): void {
  runner = r;
}

let socksCheck: typeof checkSocks5 = checkSocks5;
/** Tests only: replace the SOCKS liveness check. */
export function setSocksCheck(c: typeof checkSocks5): void {
  socksCheck = c;
}

/** What we set: SOCKS for every proxy-aware app, local addresses direct. */
export function oursFor(endpoint: string): ProxyState {
  return { flags: PROXY_DIRECT | PROXY_MANUAL, server: `socks=${endpoint}`, bypass: '<local>', pac: '' };
}

/** The saved state in the current form (old registry-form backups are converted). */
export function savedState(saved: Saved): ProxyState {
  if (saved.state) return saved.state;
  return { flags: PROXY_DIRECT | (saved.proxyEnable ? PROXY_MANUAL : 0), server: saved.proxyServer ?? '', bypass: '', pac: '' };
}

/** `endpoint` = the session's proxy_endpoint, e.g. "127.0.0.1:1080". */
export async function setSystemProxy(endpoint: string): Promise<void> {
  if (isAndroid()) throw new Error('On Android every protocol runs through the VPN, for all apps or the apps you pick (Settings → Split tunnelling). A system proxy is not needed.');
  if (!/^127\.0\.0\.1:\d{2,5}$/.test(endpoint)) throw new Error(`refusing non-loopback proxy endpoint ${endpoint}`); // copy:internal
  // A dead proxy as the system proxy cuts every app's internet: prove it works here first.
  const live = await socksCheck(endpoint);
  if (!live.ok) throw new Error(`The VPN's SOCKS proxy is not answering on this computer (${live.reason}). Nothing was changed.`);
  const ours = oursFor(endpoint);
  if (!fs.existsSync(storePath(BACKUP))) {
    const saved: Saved = { state: await runner.query(), ours: ours.server };
    writeJson(BACKUP, saved);
  }
  const now = await runner.set(ours);
  if (now.server !== ours.server || !(now.flags & PROXY_MANUAL)) throw new Error('Windows did not accept the proxy setting. Nothing else was changed.');
  patch({ proxyActive: true });
  log.info('system proxy set', { endpoint });
}

export function systemProxyActive(): boolean {
  return fs.existsSync(storePath(BACKUP));
}

/** Put back exactly what the user had. No-op when we never set it. */
export async function clearSystemProxy(): Promise<void> {
  const saved = readJson<Saved | null>(BACKUP, null);
  if (!saved) return;
  try {
    // Only undo if the value is still ours — the user may have changed it since.
    const now = await runner.query();
    if (now.server === saved.ours && (now.flags & PROXY_MANUAL)) await runner.set(savedState(saved));
    else log.info('system proxy changed by someone else since; left as it is', { flags: now.flags });
    fs.rmSync(storePath(BACKUP), { force: true });
    patch({ proxyActive: false });
    log.info('system proxy restored');
  } catch (err) {
    log.error('system proxy restore failed', err);
    throw err;
  }
}

export const restoreProxyOnStartup = clearSystemProxy;
