// ─── Public IP + speed test (F19.1, F19.2) ───
// Third-party services, disclosed in Settings and switchable off. Each check
// walks a fallback chain (HNS recs §2.1–2.2) so one dead service never fails it.
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { socks5Connect } from './socks';

const IP_SERVICES = ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json', 'https://ifconfig.co/json'];
const SPEED_URLS = ['https://speed.cloudflare.com/__down?bytes=10000000', 'https://proof.ovh.net/files/10Mb.dat'];

type GetResult = { status: number; body: string; bytes: number; ms: number; capped?: boolean };

/**
 * Android (D-A2): the app's own traffic never enters its VPN, so a plain request shows the direct
 * IP. dvpnd serves a same-UID SOCKS5 "probe" socket that dials through the live tunnel
 * (tunprobe); the Android entries point checks at it. Reply 3 (network unreachable) = no
 * session: the check then runs direct, which is the user's own IP, as on the desktop.
 */
let probeEndpoint: string | null = null;
export function setProbeEndpoint(endpoint: string | null): void {
  probeEndpoint = endpoint;
}

async function get(url: string, timeoutMs: number, onData?: (n: number) => void, socks?: string, maxMs?: number, tunnelOnly = false): Promise<GetResult> {
  if (!socks && probeEndpoint) {
    try {
      return await directGet(url, timeoutMs, onData, probeEndpoint, maxMs);
    } catch (err) {
      if (!/\(reply 3\)/.test((err as Error).message)) throw err;
      // Q0387: a session is shown but dvpnd has no tunnel to dial through (a redial is under way). A
      // direct check measures the phone's own IP, which is not what sites see (the kill switch holds
      // every other app): no answer, not the wrong one.
      if (tunnelOnly) throw new Error('No tunnel to measure through right now (reconnecting)', { cause: err });
    }
  }
  return directGet(url, timeoutMs, onData, socks, maxMs);
}

/**
 * `socks` = a local SOCKS5 endpoint: the request then goes through it (TLS on top).
 * `timeoutMs` is an idle timeout (no bytes for that long). `maxMs` caps the whole download: past it the
 * transfer stops and resolves with what arrived (`capped`), so a slow but steady link can't run for minutes.
 */
function directGet(url: string, timeoutMs: number, onData?: (n: number) => void, socks?: string, maxMs?: number): Promise<GetResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let settled = false;
    const u = new URL(url);
    // The request's own `createConnection` is ignored once an Agent is involved (agent:false
    // builds a fresh one), so the SOCKS dial lives on a dedicated Agent. Async form: return
    // nothing, hand the TLS socket to `cb` once SOCKS is up. No fallback to direct.
    // Always a fresh connection: Node's global agent keeps sockets alive, and a socket opened
    // before a full tunnel came up still leaves through the old route (shows the direct IP).
    let viaSocks: { agent: https.Agent } = { agent: new https.Agent({ keepAlive: false }) };
    if (socks) {
      const agent = new https.Agent({ keepAlive: false });
      // Agent.createConnection is real Node API (http.Agent) but missing from @types/node.
      (agent as unknown as { createConnection: (o: unknown, cb: (err: Error | null, s: Duplex) => void) => undefined }).createConnection = (_opts, cb) => {
        socks5Connect(socks, u.hostname, Number(u.port) || 443, timeoutMs)
          .then((raw) => cb(null, tls.connect({ socket: raw, servername: u.hostname })))
          .catch((err: Error) => cb(err, undefined as unknown as Duplex));
        return undefined;
      };
      viaSocks = { agent };
    }
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'devnet-dvpn' }, ...viaSocks }, (res) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        bytes += c.length;
        if (onData) onData(bytes); else chunks.push(c);
        if (maxMs && !settled && Date.now() - t0 >= maxMs) {
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), bytes, ms: Date.now() - t0, capped: true });
          req.destroy();
        }
      });
      res.on('end', () => { if (!settled) { settled = true; resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), bytes, ms: Date.now() - t0 }); } });
      res.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

/** Public IP; with `socks` (a proxy session's endpoint) it is the VPN exit IP. */
/** tunnelOnly (Android, a session shown): never fall back to a direct check when dvpnd has no tunnel. */
export async function publicIp(timeoutMs = 6000, socks?: string, opts: { tunnelOnly?: boolean } = {}): Promise<{ ip: string; source: string } | { error: string }> {
  const errors: string[] = [];
  for (const url of IP_SERVICES) {
    try {
      const r = await get(url, timeoutMs, undefined, socks, undefined, opts.tunnelOnly);
      const ip = (JSON.parse(r.body) as { ip?: string }).ip;
      if (r.status === 200 && ip) return { ip, source: new URL(url).host };
      errors.push(`${new URL(url).host}: HTTP ${r.status}`);
    } catch (err) {
      errors.push(`${new URL(url).host}: ${(err as Error).message}`);
    }
  }
  return { error: `No IP service answered (${errors.join('; ')})` };
}

/** Longest a speed test downloads: a slow link reports its rate from what arrived by then. */
export const SPEED_MAX_MS = 45_000;

/** `socks` = a proxy session's endpoint: the download then goes through the VPN. */
export async function speedTest(timeoutMs = 20_000, socks?: string, maxMs = SPEED_MAX_MS): Promise<{ mbps: number; bytes: number; ms: number; source: string } | { error: string }> {
  const errors: string[] = [];
  for (const url of SPEED_URLS) {
    try {
      const r = await get(url, timeoutMs, () => undefined, socks, maxMs);
      if (r.status !== 200 || r.bytes < 100_000) { errors.push(`${new URL(url).host}: HTTP ${r.status}`); continue; }
      return { mbps: Math.round((r.bytes * 8) / (r.ms / 1000) / 1e4) / 100, bytes: r.bytes, ms: r.ms, source: new URL(url).host };
    } catch (err) {
      errors.push(`${new URL(url).host}: ${(err as Error).message}`);
    }
  }
  return { error: `Speed test failed (${errors.join('; ')})` };
}
