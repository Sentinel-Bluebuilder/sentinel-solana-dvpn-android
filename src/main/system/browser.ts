// ─── Browser through the VPN (F16.2) ───
// Starts Edge or Chrome in its OWN profile with every request sent to the session's SOCKS
// endpoint and name lookups done by the node (no DNS from this computer for that window).
// The user's normal browser windows are not touched. Only V2Ray / Xray sessions expose a
// SOCKS endpoint today (Phase P adds the others).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { storePath } from '../store';
import { log } from '../logger';
import { isAndroid } from '../platform/android-bridge';

export type BrowserName = 'edge' | 'chrome';
export const BROWSERS: BrowserName[] = ['edge', 'chrome'];

/** Where each browser is normally installed on Windows (machine-wide, then per-user). */
export function browserCandidates(name: BrowserName, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => !!r);
  const rel = name === 'edge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
  return roots.map((r) => path.join(r, ...rel));
}

export function findBrowser(name: BrowserName, exists: (p: string) => boolean = fs.existsSync): string | null {
  return browserCandidates(name).find((p) => exists(p)) ?? null;
}

/** Command-line flags. Exported for tests: the DNS rule is what keeps lookups off this computer. */
export function browserArgs(endpoint: string, profileDir: string, url: string): string[] {
  if (!/^127\.0\.0\.1:\d{2,5}$/.test(endpoint)) throw new Error(`"${endpoint}" is not a local SOCKS endpoint.`);
  return [
    `--proxy-server=socks5://${endpoint}`,
    // Chrome resolves names itself unless every host is mapped away; with this rule the SOCKS5
    // proxy (the node) resolves them. 127.0.0.1 is kept so the proxy itself is reachable.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-quic', // QUIC is UDP; a SOCKS5 proxy here carries TCP only.
    '--new-window',
    url,
  ];
}

export interface LaunchResult { browser: BrowserName; exe: string; endpoint: string; profileDir: string }

/** Launch the first installed browser (or the one asked for) through `endpoint`. */
export function launchBrowser(endpoint: string, want?: BrowserName, url = 'https://api.ipify.org'): LaunchResult {
  if (isAndroid()) throw new Error('On Android the VPN already covers your browser: pick it under Settings → Split tunnelling. A separate proxied browser is a desktop feature.');
  const order = want ? [want] : BROWSERS;
  for (const name of order) {
    const exe = findBrowser(name);
    if (!exe) continue;
    const profileDir = storePath(`browser-${name}`);
    fs.mkdirSync(profileDir, { recursive: true });
    const child = spawn(exe, browserArgs(endpoint, profileDir, url), { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => log.error('browser launch failed', { exe, err: err.message }));
    child.unref();
    log.info('browser launched through the VPN', { browser: name, endpoint });
    return { browser: name, exe, endpoint, profileDir };
  }
  throw new Error(want ? `${want === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} is not installed on this computer.` : 'Neither Microsoft Edge nor Google Chrome is installed on this computer.');
}
