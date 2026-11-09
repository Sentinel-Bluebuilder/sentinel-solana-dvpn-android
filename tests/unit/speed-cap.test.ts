// ─── Speed test caps the whole download (a slow but steady link must not run for minutes) ───
// Test Lab: Hysteria2 at ~0.7 Mbps took > 120 s for 10 MB, because the 20 s timeout is an idle
// timeout; the phone test's exec hook gave up first ("hook: Try again").
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

const st = vi.hoisted(() => ({ destroyed: 0, ends: false }));

vi.mock('node:https', () => {
  class Agent { constructor(_o?: unknown) {} }
  function get(_url: string, _opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) {
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    let timer: ReturnType<typeof setInterval> | null = null;
    req.destroy = () => { st.destroyed += 1; if (timer) clearInterval(timer); };
    setImmediate(() => {
      cb(res);
      let sent = 0;
      timer = setInterval(() => {
        res.emit('data', Buffer.alloc(64 * 1024));
        sent += 1;
        if (st.ends && sent >= 4) { if (timer) clearInterval(timer); res.emit('end'); }
      }, 5);
    });
    return req;
  }
  return { default: { get, Agent }, get, Agent };
});

const { speedTest } = await import('../../src/core/quality/quality');

describe('speed test total cap', () => {
  it('a never-ending slow download stops at the cap and reports the rate so far', async () => {
    st.destroyed = 0; st.ends = false;
    const t0 = Date.now();
    const r = await speedTest(20_000, undefined, 120);
    const took = Date.now() - t0;
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.bytes).toBeGreaterThan(100_000);
    expect(r.ms).toBeGreaterThanOrEqual(120);
    expect(took).toBeLessThan(2_000);
    expect(r.mbps).toBeGreaterThan(0);
    expect(st.destroyed).toBe(1);
  });

  it('a download that ends before the cap is measured as before', async () => {
    st.destroyed = 0; st.ends = true;
    const r = await speedTest(20_000, undefined, 10_000);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.bytes).toBe(4 * 64 * 1024);
    expect(st.destroyed).toBe(0);
  });
});
