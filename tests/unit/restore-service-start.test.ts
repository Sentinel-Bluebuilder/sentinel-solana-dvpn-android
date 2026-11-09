// ─── Restore network with the VPN service down (C18, builder-kb; linux-app 19bff7a7) ───
// A stopped service is started without elevation and the restore runs once more; otherwise the
// person is told to restart Windows, as before.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  svc: 'started' as string,
  up: false,
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
  daemon: () => ({
    listSessions: async () => { if (!st.up) throw new Error('daemon down'); return []; },
    stopSession: async () => { throw Object.assign(new Error('none'), { kind: 'not-found' }); },
  }),
  daemonInfo: () => ({ reachable: false }),
  startServiceIfStopped: async () => { st.starts += 1; if (st.svc === 'started') st.up = true; return st.svc; },
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


const { restoreNetwork } = await import('../../src/main/services/connection');

beforeEach(() => { st.state = { session: null, conn: { phase: 'idle' }, lastConnectError: null }; st.reachable = []; st.starts = 0; st.up = false; });

describe('restore network when the VPN service is down', () => {
  it('stopped service: started, waited for, restore runs again and succeeds', async () => {
    st.svc = 'started'; st.reachable = [true];
    const r = await restoreNetwork();
    expect(st.starts).toBe(1);
    expect(r.ok).toBe(true);
  });

  it.each(['no-right', 'failed', 'no-service'])('%s: the restart text, one start attempt only', async (svc) => {
    st.svc = svc;
    const r = await restoreNetwork();
    expect(st.starts).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('daemon-unavailable');
    expect(r.error).toMatch(/Restart Windows/);
  });

  it('started but never answers: restart text, no loop', async () => {
    st.svc = 'started'; st.reachable = [false]; st.up = false;
    const r = await restoreNetwork();
    expect(r.code).toBe('daemon-unavailable');
    expect(st.starts).toBe(1);
  });
});
