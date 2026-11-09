import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const st = vi.hoisted(() => ({
  dir: '',
  starts: 0,
  onPreflight: null as null | (() => void),
  start: null as null | (() => Promise<unknown>),
  sessions: [] as unknown[],
  left: [] as string[],
  state: { session: null as unknown, conn: { phase: 'idle' } as Record<string, unknown>, lastConnectError: null as unknown },
}));
vi.mock('../../src/main/host', () => ({ getHost: () => ({ dataDir: st.dir }) }));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => st.state,
  patch: (p: Record<string, unknown>) => { Object.assign(st.state, p); },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/main/daemon/manager', () => {
  const d = new Proxy({}, { get: (_t, k) => {
    if (k === 'startSession') return async () => { st.starts++; if (st.start) return st.start(); throw new Error('unexpected start'); };
    if (k === 'listSessions') return async () => st.sessions;
    if (k === 'stopSession') return async () => ({ session: null, killSwitchReleased: false, dnsRevertFailed: false });
    return async () => null;
  } });
  return { daemon: () => d, daemonInfo: () => ({ reachable: true, device: 'Dev', networkOk: true }) };
});
vi.mock('../../src/main/services/daemon-wait', () => ({ SERVICE_WAIT_MS: 1, waitForDaemon: async () => ({ reachable: true, device: 'Dev', networkOk: true }) }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => 'Owner' }));
vi.mock('../../src/main/services/connect-checks', () => ({
  preflight: async () => { st.onPreflight?.(); return null; }, reusableChannel: async () => null, prepayCost: () => '1',
  planLimitReached: async () => null, heldTicket: async () => null, nodeHasRoom: async () => false,
}));
vi.mock('../../src/main/home-ip', () => ({ ensureHomeIp: async () => undefined }));
vi.mock('../../src/core/nodes/discovery', () => ({ discoverNode: async () => ({ pricePerGb: '1000', pricePerHour: '1000', country: 'US' }) }));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ claimForReuse: () => true, settleChannelSoon: vi.fn(), settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/main/system/tunnels', () => ({ leftoverTunnels: async () => st.left, rivalVpns: async () => [], removeTunnelServices: async () => undefined }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { killSwitch: 'off', dnsServers: [] } }), serviceUsesTun: () => false, splitForSession: vi.fn() }));
vi.mock('../../src/main/services/stop-session', () => ({ stopLiveOrCurrent: async () => ({ session: null, dnsRevertFailed: false }) }));
vi.mock('../../src/main/services/first-data', () => ({ firstData: async () => undefined }));
vi.mock('../../src/main/services/net-settle', () => ({ waitForDirectPath: async () => true }));

const { connect } = await import('../../src/main/services/connection');
const req = { node: 'NodeB', basis: 'per_gb' as const, units: 1, confirmed: true as const };

beforeEach(() => {
  st.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-q191-'));
  st.state = { session: null, conn: { phase: 'idle' }, lastConnectError: null };
  st.starts = 0; st.onPreflight = null; st.start = null; st.sessions = []; st.left = [];
});
afterEach(() => { fs.rmSync(st.dir, { recursive: true, force: true }); });

// Q0191: `connect B --switch` while A (xray) is still coming up is refused; A's xray.exe is A's, not
// a leftover, so the failed connect must not send the user to Restore network (that ends A).
describe('failed connect while another session runs (Q0191)', () => {
  it('a tunnel that belongs to a running session is not reported as left over', async () => {
    st.left = ['xray.exe'];
    st.sessions = [{ id: 'A1', node: 'NodeA', service: 'xray', status: 'connecting', channel: 'C1', error: '' }];
    st.start = async () => { throw new Error('9 FAILED_PRECONDITION: session already active'); };
    const r = await connect(req);
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe('tunnel-left');
    expect(JSON.stringify(r)).not.toContain('restore-network');
    expect(st.state.conn.restoreNetwork).toBeFalsy();
  });

  it('negative control: with no session behind it the tunnel is still reported (gap #29)', async () => {
    st.left = ['xray.exe'];
    st.start = async () => { throw new Error('node refused the session'); };
    const r = await connect(req);
    expect(r).toMatchObject({ ok: false, code: 'tunnel-left', action: 'restore-network' });
  });
});
