// ─── SOCKS5 CONNECT (no auth) ───
// Opens a TCP stream to host:port through a local SOCKS5 proxy (the V2Ray/Xray session's
// endpoint). The host is sent as a domain name, so DNS is resolved at the VPN exit and
// does not leak. Used to measure the VPN's exit IP for proxy sessions (F9.5, F16).
// `endpoint` is "host:port", or "unix:@name" for an abstract unix socket (Android probe server).
import net from 'node:net';

export function socks5Connect(endpoint: string, host: string, port: number, timeoutMs = 8000): Promise<net.Socket> {
  const unixPath = endpoint.startsWith('unix:') ? endpoint.slice(5).replace(/^@/, '\0') : null;
  const [pHost, pPortStr] = unixPath ? ['unix', '1'] : endpoint.split(':');
  const pPort = Number(pPortStr);
  const name = Buffer.from(host, 'utf8');
  if (!pHost || !pPort || (unixPath !== null && unixPath.length < 2) || name.length < 1 || name.length > 255 || !(port > 0 && port < 65536)) {
    return Promise.reject(new Error(`bad SOCKS request (${endpoint} → ${host}:${port})`));
  }
  return new Promise((resolve, reject) => {
    const sock = unixPath ? net.connect({ path: unixPath }) : net.connect({ host: pHost, port: pPort });
    let stage: 'greet' | 'connect' = 'greet';
    let buf = Buffer.alloc(0);
    const fail = (msg: string): void => { clearTimeout(timer); sock.destroy(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail(`SOCKS ${endpoint}: no answer within ${timeoutMs} ms.`), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(`SOCKS ${endpoint}: not a no-auth SOCKS5 proxy.`);
        buf = buf.subarray(2);
        stage = 'connect';
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
        return;
      }
      // Reply: VER REP RSV ATYP BND.ADDR BND.PORT — wait for the whole header before handing over.
      if (buf.length < 5) return;
      if (buf[1] !== 0x00) return fail(`SOCKS ${endpoint}: could not reach ${host}:${port} (reply ${buf[1]})`);
      const addrLen = buf[3] === 0x01 ? 4 : buf[3] === 0x04 ? 16 : buf[3] === 0x03 ? 1 + buf[4] : -1;
      if (addrLen < 0) return fail(`SOCKS ${endpoint}: bad reply address type ${buf[3]}`);
      const total = 4 + addrLen + 2;
      if (buf.length < total) return;
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      if (buf.length > total) sock.unshift(buf.subarray(total));
      resolve(sock);
    };
    const onError = (err: Error): void => fail(`SOCKS ${endpoint}: ${err.message}`);
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', onData);
    sock.on('error', onError);
  });
}
