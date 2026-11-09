// ─── Wait for the direct path after a tunnel stops ───
// On a switch the next server is paid for seconds after the old tunnel went down. OpenVPN in
// particular takes a while to remove its routes, and every chain read in that window fails
// with "fetch failed" (VM matrix 2026-10-21: openvpn → hysteria2). dvpnd's own reads need the
// same path. Wait here until the RPC answers, so neither the app nor dvpnd starts too early.
import { rpcCall } from '../../core/chain/rpc';
import { log } from '../logger';

export const SETTLE_MAX_MS = 20_000;
const STEP_MS = 1_000;

/** Resolves true once the RPC answers (or false after `maxMs`); never throws. */
export async function waitForDirectPath(maxMs = SETTLE_MAX_MS, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  const started = Date.now();
  let tries = 0;
  while (Date.now() - started < maxMs) {
    tries++;
    try {
      await rpcCall((c) => c.getSlot(), { label: 'switch-settle', attempts: 1, timeoutMs: 3_000 });
      if (tries > 1) log.info('network back after the old tunnel stopped', { ms: Date.now() - started, tries });
      return true;
    } catch (err) {
      if (tries === 1) log.warn('network not back yet after the old tunnel stopped; waiting', { err: (err as Error).message.split('\n')[0] });
    }
    await sleep(STEP_MS);
  }
  log.warn('network still not answering after the old tunnel stopped', { ms: maxMs, tries });
  return false;
}

// ─── Wait for DNS through a new full tunnel ───
// AmneziaWG on the GCP VM (2026-10-21): data flowed at once, but every name lookup failed for
// the first ~2.2 s ("Could not resolve host") until Windows applied the tunnel's DNS server.
// Saying "Connected" in that gap made the first page load fail. Wait for one lookup to work.
export const DNS_READY_MAX_MS = 6_000;

/** Resolves true once `host` resolves (or false after `maxMs`); never throws. */
export async function waitForDns(host: string, maxMs = DNS_READY_MAX_MS, lookup: (h: string) => Promise<unknown> = (h) => import('node:dns').then((d) => d.promises.lookup(h)), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  const started = Date.now();
  let tries = 0;
  while (Date.now() - started < maxMs) {
    tries++;
    try {
      await lookup(host);
      if (tries > 1) log.info('DNS ready through the tunnel', { ms: Date.now() - started, tries });
      return true;
    } catch (err) {
      if (tries === 1) log.info('DNS not ready yet through the tunnel; waiting', { err: (err as Error).message });
    }
    await sleep(250);
  }
  log.warn('DNS still not answering through the tunnel', { host, ms: maxMs, tries });
  return false;
}
