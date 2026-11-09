// ─── Internet reachability (F14.3) ───
// Only TCP connects, no data sent, so it works with third-party checks off. Never the RPC hosts:
// since rc the kill switch PERMITS them (a switch or reconnect must pay through the block), so
// reaching them proves nothing - the app said "Ready" while the kill switch blocked everything
// else (VM ui-win-1 2026-10-22, WireGuard killed with KS on). A plain site by name (needs DNS,
// which the block also stops), then public anycast addresses on 443. One success is enough.
import net from 'node:net';

export type Dialer = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const TARGETS: Array<[string, number]> = [['www.msftconnecttest.com', 80], ['1.1.1.1', 443], ['8.8.8.8', 443]];

export const tcpDial: Dialer = (host, port, timeoutMs) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
  s.setTimeout(timeoutMs, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/** Hosts to try: never one the kill switch leaves open (the RPC hosts), so an answer means the
 *  internet itself works. RPC hosts given are dropped even if they match a target. */
export function reachTargets(rpcUrls: string[]): Array<[string, number]> {
  const rpc = new Set<string>();
  for (const raw of rpcUrls) if (URL.canParse(raw)) rpc.add(new URL(raw).hostname);
  return TARGETS.filter(([h]) => !rpc.has(h));
}

export async function internetReachable(rpcUrls: string[], { dial = tcpDial, timeoutMs = 4000 } = {}): Promise<boolean> {
  const results = await Promise.all(reachTargets(rpcUrls).map(([h, p]) => dial(h, p, timeoutMs)));
  return results.some(Boolean);
}
