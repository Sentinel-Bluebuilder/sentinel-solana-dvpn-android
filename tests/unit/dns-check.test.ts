import { describe, expect, it } from 'vitest';
import { leftoverDns, parseAdapterDns } from '../../src/main/system/dns-check';
import { benchMs, resetRpcTransport } from '../../src/core/chain/rpc';

describe('DNS leftover check (UPSTREAM-GAPS #25)', () => {
  // Shape from the clean GCP Windows VM after disconnect (2026-10-20).
  const after = parseAdapterDns('{"InterfaceAlias":"Ethernet","ServerAddresses":["10.128.0.1"]}');

  it('treats the daemon report as a false alarm when no adapter keeps the VPN DNS', () => {
    expect(after).toEqual([{ alias: 'Ethernet', servers: ['10.128.0.1'] }]);
    expect(leftoverDns(after, ['1.1.1.1', '1.0.0.1'])).toEqual([]);
  });

  it('flags a real leftover on a physical adapter, never the tunnel itself', () => {
    const rows = parseAdapterDns('[{"InterfaceAlias":"Wi-Fi","ServerAddresses":["1.1.1.1"]},{"InterfaceAlias":"dvpn-wg-client","ServerAddresses":"1.0.0.1"}]');
    expect(leftoverDns(rows, ['1.1.1.1', '1.0.0.1']).map((a) => a.alias)).toEqual(['Wi-Fi']);
  });
});

describe('RPC bench after a route change', () => {
  it('benches briefly while routes settle, a minute otherwise, 8 s on 429', () => {
    resetRpcTransport();
    const now = Date.now();
    expect(benchMs(new Error('fetch failed'), now + 1_000)).toBe(3_000);
    expect(benchMs(new Error('fetch failed'), now + 60_000)).toBe(60_000);
    expect(benchMs(new Error('429 Too Many Requests'), now + 1_000)).toBe(8_000);
  });
});
