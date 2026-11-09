import { describe, expect, it } from 'vitest';
import { dnsQuery, isReplyTo, probeDns, dnsProbeProblem, dnsDoctorRow, type ProbeIo } from '../../src/main/system/dns-probe';

// ─── Fake resolvers: no sockets ───
function io(alive: Record<string, boolean>): ProbeIo {
  return {
    async send(server, query) {
      if (!alive[server]) return null;
      const reply = Buffer.from(query);
      reply[2] |= 0x80; // QR = response
      return reply;
    },
  };
}

describe('dns probe', () => {
  it('builds a standard A query for example.com', () => {
    const q = dnsQuery(0x1234);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(4)).toBe(1);
    expect(q.subarray(12).toString('latin1')).toBe('\x07example\x03com\x00\x00\x01\x00\x01');
  });

  it('accepts only a reply with our id and the QR bit', () => {
    const q = dnsQuery(7);
    expect(isReplyTo(7, q)).toBe(false); // a query is not a reply
    const r = Buffer.from(q); r[2] |= 0x80;
    expect(isReplyTo(7, r)).toBe(true);
    expect(isReplyTo(8, r)).toBe(false);
    expect(isReplyTo(7, Buffer.alloc(4))).toBe(false);
    const nx = Buffer.from(r); nx[3] = (nx[3] & 0xf0) | 3;
    expect(isReplyTo(7, nx)).toBe(true); // NXDOMAIN: the server resolves
    for (const code of [2, 5]) { // SERVFAIL, REFUSED: it will not resolve for us
      const bad = Buffer.from(r); bad[3] = (bad[3] & 0xf0) | code;
      expect(isReplyTo(7, bad)).toBe(false);
    }
  });

  it('skips non-IP entries and reports each server', async () => {
    const rows = await probeDns(['1.1.1.1', 'not-an-ip', '103.196.38.38'], 50, io({ '1.1.1.1': true }));
    expect(rows.map((r) => [r.server, r.ok])).toEqual([['1.1.1.1', true], ['103.196.38.38', false]]);
  });

  it('warns only when no server answers', async () => {
    expect(dnsProbeProblem(await probeDns(['1.1.1.1', '1.0.0.1'], 50, io({ '1.0.0.1': true })))).toBeNull();
    const p = dnsProbeProblem(await probeDns(['103.196.38.38', '103.196.38.39'], 50, io({})));
    expect(p).toContain('103.196.38.38, 103.196.38.39');
    expect(p).toContain('daemon set --dns');
    expect(dnsProbeProblem([])).toBeNull();
  });

  it('doctor row: ok, partial warn, all-dead warn, none configured', async () => {
    expect((await dnsDoctorRow(['1.1.1.1'], io({ '1.1.1.1': true })))?.level).toBe('ok');
    const part = await dnsDoctorRow(['1.1.1.1', '9.9.9.9'], io({ '1.1.1.1': true }));
    expect(part).toMatchObject({ ok: true, level: 'warn' });
    expect(part?.detail).toContain('9.9.9.9');
    expect(await dnsDoctorRow(['103.196.38.38'], io({}))).toMatchObject({ name: 'dns_servers', ok: false, level: 'warn' });
    expect(await dnsDoctorRow([], io({}))).toBeNull();
  });
});
