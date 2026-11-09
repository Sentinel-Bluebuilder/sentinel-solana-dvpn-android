// ─── DC1: a Disconnect from ANOTHER process stops a connect in progress ───
// connect() end to end with the mocks of connect-stop.test.ts, plus a real data dir: the other
// process's stop request is the connect-cancel.json file it writes (connect-marker.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const st = vi.hoisted(() => ({
  dir: '',
  starts: 0,
  onPreflight: null as null | (() => void),
  start: null as null | (() => Promise<unknown>),
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
vi.mock('../../src/main/system/tunnels', () => ({ leftoverTunnels: async () => [], rivalVpns: async () => [], removeTunnelServices: async () => undefined }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { killSwitch: 'off', dnsServers: [] } }), serviceUsesTun: () => false, splitForSession: vi.fn() }));
vi.mock('../../src/main/services/stop-session', () => ({ stopLiveOrCurrent: async () => ({ session: null, dnsRevertFailed: false }) }));
vi.mock('../../src/main/services/first-data', () => ({ firstData: async () => undefined }));
vi.mock('../../src/main/services/net-settle', () => ({ waitForDirectPath: async () => true }));

const { connect } = await import('../../src/main/services/connection');
const req = { node: 'NodeA', basis: 'per_gb' as const, units: 1, confirmed: true as const };
const marker = (): string => path.join(st.dir, 'connect-in-progress.json');
/** What a Disconnect in another process writes (requestCancel). */
const stopFromOtherProcess = (): void => fs.writeFileSync(path.join(st.dir, 'connect-cancel.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));

beforeEach(() => {
  st.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-dc1c-'));
  st.state = { session: null, conn: { phase: 'idle' }, lastConnectError: null };
  st.starts = 0; st.onPreflight = null; st.start = null;
});
afterEach(() => { fs.rmSync(st.dir, { recursive: true, force: true }); });

describe('Disconnect from another process while connecting (DC1)', () => {
  it('stop requested before the deposit: nothing paid, dvpnd never asked to start', async () => {
    st.onPreflight = () => { expect(fs.existsSync(marker())).toBe(true); stopFromOtherProcess(); };
    const r = await connect(req);
    expect(r).toMatchObject({ ok: false, code: 'cancelled', error: 'Connecting stopped. Nothing was paid.' });
    expect(st.starts).toBe(0);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('stop requested while dvpnd is starting (empty gRPC details): reads as the stop, not a failure', async () => {
    st.start = async () => { stopFromOtherProcess(); throw new Error('9 FAILED_PRECONDITION: '); };
    const r = await connect(req);
    expect(r.code).toBe('cancelled');
    expect(st.state.conn.phase).toBe('idle');
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('negative control: with no stop request the connect goes ahead and starts', async () => {
    st.start = async () => ({ id: 'S1', node: 'NodeA', service: 'wireguard', status: 'active', channel: 'C1', error: '' });
    const r = await connect(req);
    expect(r.ok).toBe(true);
    expect(st.starts).toBe(1);
    expect(fs.existsSync(marker())).toBe(false);
  });
});
