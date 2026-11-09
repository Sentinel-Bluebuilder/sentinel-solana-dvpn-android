import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { socks5Connect } from '../../src/core/quality/socks';
import { publicIp } from '../../src/core/quality/quality';

// A tiny SOCKS5 server that records the CONNECT target, then echoes bytes back.
function fakeSocks(reply = 0x00): Promise<{ port: number; target: () => string; close: () => Promise<void> }> {
  let target = '';
  const srv = net.createServer((s) => {
    let stage = 0;
    s.on('data', (d) => {
      if (stage === 0) { s.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
      if (stage === 1) {
        const len = d[4];
        target = `${d.subarray(5, 5 + len).toString()}:${d.readUInt16BE(5 + len)}`;
        // reply with a domain-type bound address to exercise the variable-length header
        s.write(Buffer.concat([Buffer.from([0x05, reply, 0x00, 0x03, 3]), Buffer.from('abc'), Buffer.from([0, 80])]));
        stage = 2;
        if (reply !== 0x00) s.end();
        return;
      }
      s.write(d);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    port: (srv.address() as net.AddressInfo).port,
    target: () => target,
    close: () => new Promise((c) => srv.close(() => c())),
  })));
}

describe('socks5Connect', () => {
  it('sends the host as a domain (remote DNS) and hands over a clean stream', async () => {
    const f = await fakeSocks();
    const sock = await socks5Connect(`127.0.0.1:${f.port}`, 'api.ipify.org', 443, 3000);
    expect(f.target()).toBe('api.ipify.org:443');
    const got = await new Promise<string>((r) => { let acc = ''; sock.on('data', (d) => { acc += d.toString(); if (acc.length >= 2) r(acc); }); sock.write('xy'); });
    expect(got).toBe('xy'); // the stream after the handshake is the target's
    sock.destroy();
    await f.close();
  });

  it('rejects when the proxy cannot reach the target', async () => {
    const f = await fakeSocks(0x05);
    await expect(socks5Connect(`127.0.0.1:${f.port}`, 'example.org', 443, 3000)).rejects.toThrow(/reply 5/);
    await f.close();
  });

  it('publicIp through a dead SOCKS endpoint errors instead of going direct', async () => {
    const r = await publicIp(2000, '127.0.0.1:1');
    expect('error' in r).toBe(true);
  });

  it('rejects a dead endpoint', async () => {
    await expect(socks5Connect('127.0.0.1:1', 'example.org', 443, 2000)).rejects.toThrow(/SOCKS 127.0.0.1:1/);
  });

  it('rejects an empty unix endpoint', async () => {
    await expect(socks5Connect('unix:@', 'example.org', 443, 2000)).rejects.toThrow(/bad SOCKS request/);
  });

  // Android probe server (dvpnd tunprobe) listens on an abstract unix socket: Linux only.
  it.skipIf(process.platform !== 'linux')('dials an abstract unix endpoint (unix:@name)', async () => {
    let target = '';
    const name = `ddv-test-${process.pid}-${Date.now()}`;
    const srv = net.createServer((s) => {
      let stage = 0;
      s.on('data', (d) => {
        if (stage === 0) { s.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
        const len = d[4];
        target = `${d.subarray(5, 5 + len).toString()}:${d.readUInt16BE(5 + len)}`;
        s.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
    });
    await new Promise<void>((r) => srv.listen(`\0${name}`, () => r()));
    const sock = await socks5Connect(`unix:@${name}`, 'api.ipify.org', 443, 3000);
    expect(target).toBe('api.ipify.org:443');
    sock.destroy();
    await new Promise<void>((c) => srv.close(() => c()));
  });
});

describe('probe endpoint (Android)', () => {
  it('a probe that cannot reach the target is an error, never a silent direct measurement', async () => {
    const { setProbeEndpoint } = await import('../../src/core/quality/quality');
    const f = await fakeSocks(0x05);
    setProbeEndpoint(`127.0.0.1:${f.port}`);
    try {
      const r = await publicIp(3000);
      expect('error' in r).toBe(true);
      expect(f.target()).toMatch(/:443$/);
    } finally {
      setProbeEndpoint(null);
      await f.close();
    }
  });

  // Q0387: mid-redial dvpnd has no tunnel (reply 3). With a session shown the check must not fall
  // back to direct: that is the phone's own IP, which the Connect panel then showed as "Sites see".
  it('tunnelOnly: no tunnel (reply 3) is an error, not a direct measurement', async () => {
    const { setProbeEndpoint } = await import('../../src/core/quality/quality');
    const f = await fakeSocks(0x03);
    setProbeEndpoint(`127.0.0.1:${f.port}`);
    let direct = 0;
    const real = net.Socket.prototype.connect;
    // Count connects that are not to the fake probe: a direct fallback would make one.
    const spy = function (this: net.Socket, ...args: unknown[]): net.Socket {
      // Node calls connect with a normalised [options, cb] array internally.
      const a0 = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
      const port = typeof a0 === 'object' && a0 !== null ? Number((a0 as { port?: unknown }).port) : Number(a0);
      if (port !== f.port) direct++;
      return (real as (...a: unknown[]) => net.Socket).apply(this, args);
    };
    net.Socket.prototype.connect = spy as typeof real;
    try {
      const r = await publicIp(3000, undefined, { tunnelOnly: true });
      expect('error' in r && r.error).toMatch(/No tunnel to measure through/);
      expect(direct).toBe(0);
    } finally {
      net.Socket.prototype.connect = real;
      setProbeEndpoint(null);
      await f.close();
    }
  });

  it('the scheduler asks for tunnelOnly on Android while a session is shown', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../src/main/scheduler.ts'), 'utf8');
    expect(src).toMatch(/publicIp\(6000, socks, \{ tunnelOnly: isAndroid\(\) && sid !== null \}\)/);
  });
});
