// The system proxy is only set when the SOCKS endpoint really works on this machine.
import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSocks5 } from '../../src/core/quality/socks-check';

const servers: net.Server[] = [];
function serve(handler: (s: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer(handler).listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
    servers.push(srv);
  });
}
afterAll(() => { for (const s of servers) s.close(); });

describe('checkSocks5', () => {
  it('accepts a proxy that greets and connects', async () => {
    const port = await serve((s) => {
      let n = 0;
      s.on('data', () => { s.write(n++ === 0 ? Buffer.from([5, 0]) : Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); });
    });
    expect((await checkSocks5(`127.0.0.1:${port}`)).ok).toBe(true);
  });
  it('rejects a closed port (the box-rig case: endpoint is on another host)', async () => {
    const port = await serve(() => undefined);
    servers.pop()!.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await checkSocks5(`127.0.0.1:${port}`, { timeoutMs: 1500 })).ok).toBe(false);
  });
  it('rejects a proxy that cannot reach the target', async () => {
    const port = await serve((s) => { let n = 0; s.on('data', () => { s.write(n++ === 0 ? Buffer.from([5, 0]) : Buffer.from([5, 4])); }); });
    const r = await checkSocks5(`127.0.0.1:${port}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not reach/);
  });
  it('rejects something that is not SOCKS5', async () => {
    const port = await serve((s) => s.on('data', () => s.write('HTTP/1.1 400 Bad\r\n\r\n')));
    expect((await checkSocks5(`127.0.0.1:${port}`)).ok).toBe(false);
  });
  it('times out on silence', async () => {
    const port = await serve(() => undefined);
    const r = await checkSocks5(`127.0.0.1:${port}`, { timeoutMs: 300 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/no answer/) });
  });
});
