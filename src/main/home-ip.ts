// ─── The user's own IP: the reference for "is traffic really going through the VPN" ───
// core/session/coverage compares the session's exit IP with it. The app measures it while idle
// (scheduler 'ip' job); a machine that only ever used the CLI never did, so `status` could not
// tell "Protected" from "checking" (fresh 24.04 / 22.04 VMs, 2026-10-21). Kept on disk so a
// later process (CLI status, an app started mid-session) has it.
import { readJson, writeJson } from './store';
import { patch, snapshot } from './app-state';
import { publicIp } from '../core/quality/quality';
import { getSettings } from './system/settings';
import { log } from './logger';

export const HOME_IP = 'home-ip.json';

export function loadHomeIp(): void {
  if (snapshot().homeIp !== null) return;
  const h = readJson<{ ip?: string } | null>(HOME_IP, null);
  if (h?.ip) patch({ homeIp: h.ip });
}

export function saveHomeIp(ip: string): void {
  patch({ homeIp: ip });
  writeJson(HOME_IP, { ip, at: Date.now() });
}

/**
 * Right before a connect: measure the user's own IP if none is known yet. Only when it is
 * certain no session runs (`sessionsKnown` and none adopted), so the node's IP is never taken
 * for the user's own. One lookup at most; a failure only means status stays "checking".
 */
export async function ensureHomeIp(sessionsKnown: boolean): Promise<void> {
  loadHomeIp();
  if (snapshot().homeIp || snapshot().session || !sessionsKnown || !getSettings().thirdPartyChecks) return;
  const r = await publicIp(6000);
  if ('ip' in r) saveHomeIp(r.ip);
  else log.warn('home IP check before connect failed', { err: r.error });
}
