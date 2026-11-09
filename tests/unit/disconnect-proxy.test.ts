// ─── Disconnect waits for the system proxy to be put back ───
// the macOS app matrix 2026-10-22: after every V2Ray/Xray CLI `disconnect` the SOCKS proxy stayed set.
// ended() started the restore without waiting and the CLI process exited before it finished.
import { describe, it, expect, vi } from 'vitest';

const seen = vi.hoisted(() => ({ restored: false, session: null as unknown, phase: '', phaseAtList: '' }));
vi.mock('../../src/main/system/proxy', () => ({
  setSystemProxy: vi.fn(),
  clearSystemProxy: () => new Promise<void>((r) => setTimeout(() => { seen.restored = true; r(); }, 50)),
}));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => ({ session: seen.session }),
  patch: (p: { session?: unknown; conn?: { phase: string } }) => { if ('session' in p) seen.session = p.session; if (p.conn) seen.phase = p.conn.phase; },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/main/services/stop-session', () => ({ stopLiveOrCurrent: async () => ({ session: null, dnsRevertFailed: false }) }));
vi.mock('../../src/main/daemon/manager', () => ({ daemon: () => ({ stopSession: async () => ({ killSwitchReleased: false }), listSessions: async () => { seen.phaseAtList = seen.phase; return []; } }), daemonInfo: () => ({ reachable: true }) }));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ settleChannelSoon: vi.fn(), settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { dnsServers: [] } }), splitForSession: vi.fn() }));

const { disconnect } = await import('../../src/main/services/connection');

describe('disconnect', () => {
  it('returns only after the system proxy is restored', async () => {
    seen.restored = false;
    seen.session = { id: 's1', node: 'N', service: 'xray', channel: '', proxyEndpoint: '127.0.0.1:1080' };
    const r = await disconnect();
    expect(r.ok).toBe(true);
    expect(seen.restored).toBe(true);
  });
  it('with no session left (service restarted) still puts the system proxy back', async () => {
    seen.restored = false;
    seen.session = null;
    const r = await disconnect();
    expect(r.ok).toBe(true);
    expect(seen.restored).toBe(true);
  });
});

describe('disconnect view (W5d-b)', () => {
  it('keeps "Disconnecting" until the daemon list is checked, then shows Not connected', async () => {
    seen.session = { id: 's2', node: 'N', service: 'wireguard', channel: '' };
    seen.phase = ''; seen.phaseAtList = '';
    const r = await disconnect();
    expect(r.ok).toBe(true);
    expect(seen.phaseAtList).toBe('disconnecting');
    expect(seen.phase).toBe('idle');
  });
});
