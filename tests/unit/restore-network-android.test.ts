// ─── Restore network on Android when dvpnd does not answer (C16) ───
// The desktop copy says to restart the "dvpnd" service or Windows; a phone has neither. The app
// restarts its VPN engine itself and asks for one more Restore network.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  android: true,
  restartOk: true,
  restarts: 0,
  removed: 0,
  state: { session: null as unknown, conn: { phase: 'idle' } as Record<string, unknown>, lastConnectError: null as unknown },
}));
vi.mock('../../src/main/platform/android-bridge', () => ({ isAndroid: () => st.android, androidHeldBlock: async () => false }));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => st.state,
  patch: (p: Record<string, unknown>) => { Object.assign(st.state, p); },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: () => new Proxy({}, { get: () => async () => { throw new Error('connect ECONNREFUSED'); } }),
  daemonInfo: () => ({ reachable: false }),
  startServiceIfStopped: async () => 'failed',
  restartAndroidDaemon: async () => { st.restarts += 1; return st.restartOk ? { ok: true } : { ok: false, error: 'bridge timeout' }; },
}));
vi.mock('../../src/main/services/daemon-wait', () => ({ SERVICE_WAIT_MS: 1, waitForDaemon: async () => ({ reachable: false }) }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => 'Owner' }));
vi.mock('../../src/main/services/connect-checks', () => ({
  preflight: async () => null, reusableChannel: async () => null, prepayCost: () => '1',
  planLimitReached: async () => null, heldTicket: async () => null, nodeHasRoom: async () => false,
}));
vi.mock('../../src/main/home-ip', () => ({ ensureHomeIp: async () => undefined }));
vi.mock('../../src/core/nodes/discovery', () => ({ discoverNode: async () => null }));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ claimForReuse: () => true, settleChannelSoon: vi.fn() }));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/main/system/tunnels', () => ({
  leftoverTunnels: async () => { st.removed += 1; return []; },
  rivalVpns: async () => [],
  removeTunnelServices: async () => ({ ok: true }),
}));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { killSwitch: 'off', dnsServers: [] } }), serviceUsesTun: () => false, splitForSession: vi.fn() }));
vi.mock('../../src/main/services/stop-session', () => ({ stopLiveOrCurrent: async () => ({ session: null, dnsRevertFailed: false }) }));
vi.mock('../../src/main/services/first-data', () => ({ firstData: async () => undefined }));
vi.mock('../../src/main/services/net-settle', () => ({ waitForDirectPath: async () => true }));

const { restoreNetwork, DNS_NOT_RESTORED_COPY, ANDROID_ENGINE_RESTARTED_COPY, ANDROID_ENGINE_DOWN_COPY } = await import('../../src/main/services/connection');

beforeEach(() => { st.android = true; st.restartOk = true; st.restarts = 0; st.removed = 0; });

describe('restore network with dvpnd not answering', () => {
  it('Android: restarts the VPN engine itself, asks for Restore network again, no Windows wording', async () => {
    const r = await restoreNetwork();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('daemon-unavailable');
    expect(st.restarts).toBe(1);
    expect(r.error).toBe(ANDROID_ENGINE_RESTARTED_COPY);
    expect(r.error).not.toMatch(/Windows|dvpnd/);
    expect(st.removed).toBe(0);
  });

  it('Android: engine restart fails → phone wording, still no Windows', async () => {
    st.restartOk = false;
    const r = await restoreNetwork();
    expect(r.error).toBe(ANDROID_ENGINE_DOWN_COPY);
    expect(r.error).not.toMatch(/Windows/);
  });

  it('desktop keeps the service/Windows copy and removes orphan tunnels', async () => {
    st.android = false;
    const r = await restoreNetwork();
    expect(st.restarts).toBe(0);
    expect(st.removed).toBe(1);
    expect(r.error).toMatch(/not answering. Restart Windows/);
  });

  it('DNS restore copy follows the platform', () => {
    expect(DNS_NOT_RESTORED_COPY()).toMatch(/restart the phone/);
    expect(DNS_NOT_RESTORED_COPY()).not.toMatch(/Windows/);
    st.android = false;
    expect(DNS_NOT_RESTORED_COPY()).toMatch(/restart Windows/);
  });
});
