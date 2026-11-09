// ─── DNS server probe: does a resolver answer at all? ───
// One plain DNS query (A example.com) over UDP per server, from this computer, with a short
// timeout. Any reply (NOERROR or NXDOMAIN) means the server is alive. No system setting is read
// or changed. Found 2026-10-22: both Handshake preset resolvers (103.196.38.38/.39) stopped
// answering, so a session on that preset had no name resolution and no explanation.
import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';

export interface DnsProbe {
  server: string;
  ok: boolean;
  ms?: number;
}

/** A DNS query for `name` type A with the given id (RFC 1035 §4.1). */
export function dnsQuery(id: number, name = 'example.com'): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4); // one question
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]); // root, QTYPE A, QCLASS IN
}

/**
 * A useful reply to our query: same id, QR bit set, rcode NOERROR (0) or NXDOMAIN (3). SERVFAIL
 * or REFUSED come from a server that will not resolve for us, which is the same as no answer.
 */
export function isReplyTo(id: number, msg: Buffer): boolean {
  if (msg.length < 12 || msg.readUInt16BE(0) !== id || (msg[2] & 0x80) === 0) return false;
  const rcode = msg[3] & 0x0f;
  return rcode === 0 || rcode === 3;
}

/** Hooks for tests: no sockets in unit tests. */
export interface ProbeIo {
  send(server: string, query: Buffer, timeoutMs: number): Promise<Buffer | null>;
}

const udpIo: ProbeIo = {
  send(server, query, timeoutMs) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
      const done = (v: Buffer | null): void => { clearTimeout(t); sock.close(); resolve(v); };
      const t = setTimeout(() => done(null), timeoutMs);
      sock.on('message', (msg) => done(msg));
      sock.on('error', () => done(null));
      sock.send(query, 53, server);
    });
  },
};

export async function probeDns(servers: string[], timeoutMs = 2500, io: ProbeIo = udpIo): Promise<DnsProbe[]> {
  return Promise.all(servers.filter((s) => net.isIP(s)).map(async (server) => {
    const id = crypto.randomInt(1, 0xffff);
    const t0 = Date.now();
    const reply = await io.send(server, dnsQuery(id), timeoutMs);
    return reply && isReplyTo(id, reply) ? { server, ok: true, ms: Date.now() - t0 } : { server, ok: false };
  }));
}

/** One line for the CLI/doctor: null when at least one server answers. */
export function dnsProbeProblem(rows: DnsProbe[]): string | null {
  if (!rows.length || rows.some((r) => r.ok)) return null;
  return `None of these DNS servers answered from this computer (${rows.map((r) => r.server).join(', ')}): names may not resolve in a session. Choose another, e.g. "daemon set --dns cloudflare --yes".`;
}

/** Doctor row for the service's configured DNS servers (app Diagnostics + CLI `daemon doctor`). */
export async function dnsDoctorRow(servers: string[], io?: ProbeIo): Promise<{ name: string; ok: boolean; level: 'ok' | 'warn' | 'fail'; detail: string } | null> {
  const rows = await probeDns(servers, 2500, io);
  if (!rows.length) return null;
  const problem = dnsProbeProblem(rows);
  if (problem) return { name: 'dns_servers', ok: false, level: 'warn', detail: problem };
  const dead = rows.filter((r) => !r.ok).map((r) => r.server);
  return { name: 'dns_servers', ok: true, level: dead.length ? 'warn' : 'ok', detail: dead.length ? `Answering, except ${dead.join(', ')}.` : `All answer (${rows.map((r) => `${r.server} ${r.ms} ms`).join(', ')}).` };
}
