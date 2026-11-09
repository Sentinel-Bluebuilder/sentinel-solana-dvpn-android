// ─── First data after connect ───
// Split out of connection.ts (file size rule): waits for a new tunnel to carry traffic.
import type { DaemonSession } from '../../core/daemon/client';
import { daemon } from '../daemon/manager';
import { log } from '../logger';
import { getRpcUrls } from '../../core/chain/rpc';
import { waitForDns } from './net-settle';
import { flushDnsCache } from '../system/dns-check';

/**
 * WireGuard-family tunnels are "up" before their first handshake (AmneziaWG sends junk
 * packets first: 1-2 s). A page opened in that gap fails and Windows caches the failed DNS
 * lookup, so "Connected" was shown while the first requests failed. Wait (at most 8 s) for
 * the first bytes from the node. Never throws: the session is live either way.
 */
export async function firstData(s: DaemonSession): Promise<void> {
  if (['wireguard', 'amneziawg', 'openvpn'].includes(s.service)) await waitForRx(s);
  // Every full-tunnel protocol moves the DNS server too; names fail until Windows applies it.
  if (['wireguard', 'amneziawg', 'openvpn', 'hysteria2'].includes(s.service)) {
    flushDnsCache(); // drop failures cached in the gap
    const host = rpcHost();
    if (host) await waitForDns(host);
  }
}

async function waitForRx(s: DaemonSession): Promise<void> {
  const until = Date.now() + 8_000;
  try {
    while (Date.now() < until) {
      const now = await daemon().getSession(s.id);
      if (!now || BigInt(now.usage?.rxBytes ?? '0') > 0n) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    log.warn('no data from the node yet; reporting connected anyway', { service: s.service });
  } catch (err) {
    log.warn('first-data wait failed', { err: (err as Error).message });
  }
}

function rpcHost(): string | null {
  try { return new URL(getRpcUrls()[0]).hostname; } catch (err) { log.warn('rpc url unreadable for the DNS check', { err: (err as Error).message }); return null; }
}
