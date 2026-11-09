// ─── Gap #67: RPC hosts resolve from pinned addresses (DNS is blocked under a held kill switch) ───
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDnsPin, pinHosts, setPinFile, _seedPin, _resetDnsPin, mergeAnswers, PIN_KEEP } from '../../src/core/net/dns-pin';

afterEach(() => _resetDnsPin());

describe('dns pin', () => {
  it('a pinned RPC host answers from the pin for net.connect and fetch', async () => {
    const srv = http.createServer((_q, r) => r.end('pong'));
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = (srv.address() as AddressInfo).port;
    installDnsPin();
    pinHosts(['https://rpc.pinned.invalid']);
    _seedPin('rpc.pinned.invalid', [{ address: '127.0.0.1', family: 4 }]);
    const sock = net.connect({ host: 'rpc.pinned.invalid', port });
    await new Promise<void>((ok, bad) => { sock.once('connect', ok); sock.once('error', bad); });
    sock.destroy();
    const body = await (await fetch(`http://rpc.pinned.invalid:${port}/`)).text();
    expect(body).toBe('pong');
    srv.close();
  });

  it('other hosts still use the normal resolver', async () => {
    installDnsPin();
    pinHosts(['https://rpc.pinned.invalid']);
    const err = await new Promise<NodeJS.ErrnoException | null>((ok) => dns.lookup('other.invalid', (e) => ok(e)));
    expect(err?.code).toMatch(/ENOTFOUND|EAI_AGAIN/);
  });

  // post-release F-C4-1: a fresh process (every CLI command) starts with an empty pin; under a held
  // kill switch with a V2Ray/Xray session DNS is dropped, so the last session's answer must serve.
  it('a fresh process answers from the addresses the last one saved when DNS is blocked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-pin-'));
    const file = path.join(dir, 'rpc-pin.json');
    fs.writeFileSync(file, JSON.stringify({ 'rpc.saved.invalid': [{ address: '127.0.0.1', family: 4 }, { address: 'junk', family: 9 }] }));
    installDnsPin();
    setPinFile(file);
    pinHosts(['https://rpc.saved.invalid']);
    const t0 = Date.now();
    const addr = await new Promise<string>((ok, bad) => dns.lookup('rpc.saved.invalid', { family: 4 }, (e, a) => (e ? bad(e) : ok(a as string))));
    expect(addr).toBe('127.0.0.1');
    expect(Date.now() - t0).toBeLessThan(5000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a live answer is saved for the next process and hosts outside the pool are not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-pin-'));
    const file = path.join(dir, 'rpc-pin.json');
    installDnsPin();
    setPinFile(file);
    pinHosts(['https://localhost']);
    await new Promise<void>((ok, bad) => dns.lookup('localhost', { all: true }, (e) => (e ? bad(e) : ok())));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown[]>;
    expect(Object.keys(saved)).toEqual(['localhost']);
    expect(saved.localhost.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an unreadable pin file is ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-pin-'));
    const file = path.join(dir, 'rpc-pin.json');
    fs.writeFileSync(file, '{not json');
    expect(() => setPinFile(file)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('family filter and all:true', async () => {
    installDnsPin();
    pinHosts(['https://h.invalid']);
    _seedPin('h.invalid', [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
    const v4 = await new Promise<string>((ok) => dns.lookup('h.invalid', { family: 4 }, (_e, a) => ok(a as string)));
    expect(v4).toBe('127.0.0.1');
    const all = await new Promise<unknown>((ok) => dns.lookup('h.invalid', { all: true }, (_e, a) => ok(a)));
    expect(all).toEqual([{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
  });

  // Q0390 (Azure India, TLX2 10-30): the RPC host resolves by location; through the tunnel the app pinned the
  // US address, the held block admits only the direct-path one. Keep both, newest first, and hand out all.
  it('keeps the recent distinct answers, newest first (Q0390)', () => {
    const a = { address: '74.63.203.93', family: 4 }, b = { address: '208.115.212.49', family: 4 };
    expect(mergeAnswers([b], [a])).toEqual([b, a]);
    expect(mergeAnswers([a], [b, a])).toEqual([a, b]);
    const many = Array.from({ length: 9 }, (_, i) => ({ address: `10.0.0.${i}`, family: 4 }));
    expect(mergeAnswers(many.slice(0, 2), many.slice(2))).toHaveLength(PIN_KEEP);
  });

  it('a live answer is added to the saved one, not put in its place (Q0390)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
    const file = path.join(dir, 'rpc-pin.json');
    fs.writeFileSync(file, JSON.stringify({ 'rpc.loc.invalid': [{ address: '192.0.2.10', family: 4 }] }));
    const real = dns.lookup;
    (dns as unknown as { lookup: unknown }).lookup = (_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: '192.0.2.20', family: 4 }]);
    try {
      installDnsPin();
      pinHosts(['https://rpc.loc.invalid']);
      setPinFile(file);
      const all = await new Promise<unknown>((ok) => dns.lookup('rpc.loc.invalid', { all: true }, (_e, a) => ok(a)));
      expect(all).toEqual([{ address: '192.0.2.20', family: 4 }, { address: '192.0.2.10', family: 4 }]);
    } finally {
      _resetDnsPin();
      (dns as unknown as { lookup: unknown }).lookup = real;
    }
  });

  it('fetch connects through the pinned address that answers when the first does not (Q0390)', async () => {
    const srv = http.createServer((_q, r) => r.end('pong'));
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = (srv.address() as AddressInfo).port;
    installDnsPin();
    pinHosts(['https://rpc.two.invalid']);
    // 192.0.2.1 (TEST-NET-1) never answers, like the address a held block drops
    _seedPin('rpc.two.invalid', [{ address: '192.0.2.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    const body = await (await fetch(`http://rpc.two.invalid:${port}/`, { signal: AbortSignal.timeout(4000) })).text();
    expect(body).toBe('pong');
    // control: the dropped address alone never connects
    _seedPin('rpc.two.invalid', [{ address: '192.0.2.1', family: 4 }]);
    await expect(fetch(`http://rpc.two.invalid:${port}/x`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    srv.close();
  }, 10_000);

});
