// ─── The home IP is measured before a connect only when no session can be running ───
import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({ snap: { homeIp: null as string | null, session: null as unknown }, disk: null as { ip: string } | null, checks: true, lookups: 0, written: [] as string[] }));
vi.mock('../../src/main/store', () => ({ readJson: () => st.disk, writeJson: (_f: string, v: { ip: string }) => { st.written.push(v.ip); } }));
vi.mock('../../src/main/app-state', () => ({ snapshot: () => st.snap, patch: (p: object) => Object.assign(st.snap, p) }));
vi.mock('../../src/main/system/settings', () => ({ getSettings: () => ({ thirdPartyChecks: st.checks }) }));
vi.mock('../../src/main/logger', () => ({ log: { warn: () => undefined } }));
vi.mock('../../src/core/quality/quality', () => ({ publicIp: async () => { st.lookups += 1; return { ip: '203.0.113.9', source: 'test' }; } }));
const { ensureHomeIp } = await import('../../src/main/home-ip');

beforeEach(() => { st.snap = { homeIp: null, session: null }; st.disk = null; st.checks = true; st.lookups = 0; st.written = []; });

describe('ensureHomeIp', () => {
  it('fresh machine, no session: measures and saves it', async () => {
    await ensureHomeIp(true);
    expect(st.snap.homeIp).toBe('203.0.113.9');
    expect(st.written).toEqual(['203.0.113.9']);
  });
  it('already on disk: no lookup', async () => {
    st.disk = { ip: '198.51.100.1' };
    await ensureHomeIp(true);
    expect(st.snap.homeIp).toBe('198.51.100.1');
    expect(st.lookups).toBe(0);
  });
  it('a session may be running (not known yet, or adopted): never measured', async () => {
    await ensureHomeIp(false);
    st.snap.session = { id: 'S' };
    await ensureHomeIp(true);
    expect(st.lookups).toBe(0);
  });
  it('IP checks off in Settings: no lookup', async () => {
    st.checks = false;
    await ensureHomeIp(true);
    expect(st.lookups).toBe(0);
  });
});
