import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { internetReachable, reachTargets, tcpDial } from '../../src/core/quality/reachability';

describe('reachability (F14.3)', () => {
  it('never probes the RPC hosts: the kill switch leaves them open since rc (VM ui-win-1)', () => {
    expect(reachTargets(['https://rpc.example.org/x?k=1', 'http://127.0.0.1:8899', 'nope'])).toEqual([
      ['www.msftconnecttest.com', 80], ['1.1.1.1', 443], ['8.8.8.8', 443],
    ]);
    expect(reachTargets(['https://1.1.1.1/'])).toEqual([['www.msftconnecttest.com', 80], ['8.8.8.8', 443]]);
  });

  it('an RPC host that answers through the block does not count as internet', async () => {
    expect(await internetReachable(['https://rpc.example.org'], { dial: async (h) => h === 'rpc.example.org' })).toBe(false);
  });

  it('one answering host is enough; none means unreachable', async () => {
    expect(await internetReachable(['https://a.example'], { dial: async (h) => h === '8.8.8.8' })).toBe(true);
    expect(await internetReachable(['https://a.example'], { dial: async () => false })).toBe(false);
  });

  it('tcpDial connects to a live listener and fails fast on a closed port', async () => {
    const srv = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await tcpDial('127.0.0.1', port, 2000)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await tcpDial('127.0.0.1', port, 2000)).toBe(false);
  });
});
