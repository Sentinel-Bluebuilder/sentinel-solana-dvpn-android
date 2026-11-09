// ─── Connect with the VPN service absent vs stopped ───
// A reinstall removes the service (the setup does not register it): "not running" sent the user to
// Diagnostics for a service that did not exist (test-host kse-pk-215). Missing = set up; stopped = start it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  svc: 'no-service' as string,
  reachable: [] as boolean[],
  starts: 0,
  state: { session: null as unknown, conn: { phase: 'idle' } as Record<string, unknown>, lastConnectError: null as unknown },
}));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => st.state,
  patch: (p: Record<string, unknown>) => { Object.assign(st.state, p); },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: () => new Proxy({}, { get: () => async () => { throw new Error('reached the daemon'); } }),
  daemonInfo: () => ({ reachable: false }),
  startServiceIfStopped: async () => { st.starts += 1; return st.svc; },
}));
vi.mock('../../src/main/services/daemon-wait', () => ({ SERVICE_WAIT_MS: 1, waitForDaemon: async () => ({ reachable: st.reachable.shift() ?? false, device: 'Dev', networkOk: true }) }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => 'Owner' }));
vi.mock('../../src/main/services/connect-checks', () => ({
  preflight: async () => null, reusableChannel: async () => null, prepayCost: () => '1',
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
const { connectActionButton } = await import('../../src/shared/connect-action');
const req = { node: 'NodeA', basis: 'per_gb' as const, units: 1, confirmed: true as const };

beforeEach(() => { st.state = { session: null, conn: { phase: 'idle' }, lastConnectError: null }; st.reachable = []; st.starts = 0; });

describe('connect when the VPN service cannot be reached', () => {
  it('service not installed: says so, points to device setup (Wallet), nothing paid', async () => {
    st.svc = 'no-service';
    const r = await connect(req);
    expect(r.code).toBe('daemon-missing');
    expect(r.error).toMatch(/not installed/);
    expect(r.error).toMatch(/daemon install --yes/);
    expect(r.error).toMatch(/Nothing was paid/);
    expect(connectActionButton(r.action)?.target).toBe('wallet');
  });

  it('service stopped: started without elevation, then waited for again', async () => {
    st.svc = 'started';
    st.reachable = [false, false];
    const r = await connect(req);
    expect(st.starts).toBe(1);
    expect(r.code).toBe('daemon-unavailable');  // still down after the start: the old copy
  });

  it('service running but not answering keeps "not running" + Diagnostics', async () => {
    st.svc = 'running';
    const r = await connect(req);
    expect(r.code).toBe('daemon-unavailable');
    expect(r.action).toBe('Open diagnostics');
  });
});
