// ─── SOCKS5 liveness check (F16a safety) ───
// Before Windows is pointed at a SOCKS proxy, prove the proxy answers on THIS
// machine and can reach the internet. A dead endpoint set as the system proxy
// cuts every app's connection, so "can't tell" counts as "no".
import net from 'node:net';

export interface SocksCheck { ok: boolean; reason: string }

/** SOCKS5 no-auth greeting, then CONNECT to `target` (IPv4:port). Resolves, never throws. */
export function checkSocks5(endpoint: string, { target = '1.1.1.1:443', timeoutMs = 6000 } = {}): Promise<SocksCheck> {
  const [host, portStr] = endpoint.split(':');
  const [tHost, tPortStr] = target.split(':');
  const port = Number(portStr);
  const tPort = Number(tPortStr);
  const octets = tHost.split('.').map(Number);
  if (!host || !port || octets.length !== 4 || octets.some((o) => !(o >= 0 && o <= 255)) || !tPort) {
    return Promise.resolve({ ok: false, reason: `bad endpoint or target (${endpoint} → ${target})` });
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let stage: 'greet' | 'connect' = 'greet';
    let buf = Buffer.alloc(0);
    const done = (r: SocksCheck): void => { clearTimeout(timer); sock.destroy(); resolve(r); };
    const timer = setTimeout(() => done({ ok: false, reason: `no answer from ${endpoint} within ${timeoutMs} ms` }), timeoutMs);
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('error', (err) => done({ ok: false, reason: `${endpoint}: ${err.message}` }));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return done({ ok: false, reason: `${endpoint} is not a no-auth SOCKS5 proxy` });
        buf = buf.subarray(2);
        stage = 'connect';
        sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets, (tPort >> 8) & 0xff, tPort & 0xff]));
        return;
      }
      if (buf.length < 2) return;
      if (buf[0] === 0x05 && buf[1] === 0x00) return done({ ok: true, reason: `${endpoint} reached ${target}` });
      done({ ok: false, reason: `${endpoint} could not reach ${target} (SOCKS reply ${buf[1]})` });
    });
  });
}
