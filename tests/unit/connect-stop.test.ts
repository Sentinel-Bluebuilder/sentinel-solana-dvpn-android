// ─── A connect the user stopped is not a failure; a busy port is ───
// connect() end to end with dvpnd's real error text: the stop leaves Home "Not connected" with a
// neutral note and "Connect again" for the same server; port-in-use is an error that offers Servers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  err: '',
  writes: [] as unknown[],
  stops: [] as string[],
  settled: [] as string[],
  /** Overrides the start: default throws st.err. */
  start: null as null | (() => Promise<unknown>),
  release: null as null | ((id: string) => void),
  state: { session: null as unknown, conn: { phase: 'idle' } as Record<string, unknown>, lastConnectError: null as unknown },
}));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => st.state,
  patch: (p: Record<string, unknown>) => { if ('lastConnectError' in p) st.writes.push(p.lastConnectError); Object.assign(st.state, p); },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/main/daemon/manager', () => {
  const d = new Proxy({}, { get: (_t, k) => {
    if (k === 'startSession') return async () => { if (st.start) return st.start(); throw new Error(st.err); };
    if (k === 'stopSession') return async (id: string) => { st.stops.push(id); st.release?.(id); return { session: null, killSwitchReleased: false, dnsRevertFailed: false }; };
    return async () => null;
  } });
  return { daemon: () => d, daemonInfo: () => ({ reachable: true, device: 'Dev', networkOk: true }) };
});
vi.mock('../../src/main/services/daemon-wait', () => ({ SERVICE_WAIT_MS: 1, waitForDaemon: async () => ({ reachable: true, device: 'Dev', networkOk: true }) }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => 'Owner' }));
vi.mock('../../src/main/services/connect-checks', () => ({
  preflight: async () => null, reusableChannel: async () => null, prepayCost: () => '1',
  planLimitReached: async () => null, heldTicket: async () => null, nodeHasRoom: async () => false,
}));
vi.mock('../../src/main/home-ip', () => ({ ensureHomeIp: async () => undefined }));
vi.mock('../../src/core/nodes/discovery', () => ({ discoverNode: async () => ({ pricePerGb: '1000', pricePerHour: '1000', country: 'US' }) }));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ claimForReuse: () => true, settleChannelSoon: (c: string) => { st.settled.push(c); }, settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/main/system/tunnels', () => ({ leftoverTunnels: async () => [], rivalVpns: async () => [], removeTunnelServices: async () => undefined }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { killSwitch: 'off', dnsServers: [] } }), serviceUsesTun: () => false, splitForSession: vi.fn() }));
vi.mock('../../src/main/services/stop-session', () => ({ stopLiveOrCurrent: async (id: string) => { st.stops.push(id); return { session: null, dnsRevertFailed: false }; } }));
vi.mock('../../src/main/services/first-data', () => ({ firstData: async () => undefined }));
vi.mock('../../src/main/services/net-settle', () => ({ waitForDirectPath: async () => true }));

const { connect, cancelConnect } = await import('../../src/main/services/connection');
const req = { node: 'NodeA', basis: 'per_gb' as const, units: 1, confirmed: true as const };

beforeEach(() => { st.state = { session: null, conn: { phase: 'idle' }, lastConnectError: null }; st.start = null; st.release = null; st.stops = []; st.settled = []; });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const session = { id: 'S1', node: 'NodeA', service: 'wireguard', status: 'active', channel: 'Chan1', error: '', rxBytes: '0', txBytes: '0' };

describe('connect stopped or failed', () => {
  it('Disconnect while connecting: neutral, "Connect again" for the same server', async () => {
    st.err = 'failed precondition: stop requested while connecting: starting service: failed to listen TCP on 1080';
    const r = await connect(req);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cancelled');
    expect(r.action).toBe('Connect again');
    // Not an error state: Home stays "Not connected", nothing red; the stop wins over the step's error.
    expect(st.state.conn.phase).toBe('idle');
    expect(st.state.conn.title).toBe('Not connected');
    expect(st.state.lastConnectError).toMatchObject({ code: 'cancelled', action: 'Connect again', node: 'NodeA' });
  });

  it('port in use: an error that names the port and offers another protocol', async () => {
    st.err = 'starting service: failed to listen TCP on 10808: bind: address already in use';
    const r = await connect(req);
    expect(r.code).toBe('port-in-use');
    expect(r.error).toMatch(/port 10808/);
    expect(st.state.conn.phase).toBe('error');
    expect(st.state.lastConnectError).toMatchObject({ code: 'port-in-use', action: 'Try another protocol', node: 'NodeA' });
  });

  it('a new connect clears the last problem before it starts', async () => {
    st.err = 'starting service: failed to listen TCP on 1080';
    await connect(req);
    st.writes = [];
    st.err = 'stop requested while connecting';
    await connect(req);
    // Cleared first (Home drops the old note), then the new outcome.
    expect(st.writes[0]).toBeNull();
    expect(st.writes.at(-1)).toMatchObject({ code: 'cancelled' });
  });


  it('Cancel while dvpnd is paying/starting asks dvpnd to stop, and the start ends as a stop (was ignored)', async () => {
    // dvpnd's start blocks until a StopSession arrives, then fails the way dvpnd does.
    st.start = () => new Promise((_res, rej) => { st.release = () => rej(new Error('failed precondition: stop requested while connecting: opening channel')); });
    const p = connect(req);
    await tick();
    expect(st.state.conn.phase).toBe('paying');
    await cancelConnect();
    const r = await p;
    expect(st.stops).toEqual(['']);
    expect(r.code).toBe('cancelled');
    expect(st.state.conn.phase).toBe('idle');
    expect(st.state.session).toBeNull();
  });

  it('Cancel still ends as a stop when dvpnd\'s error text never arrives (gate30: "9 FAILED_PRECONDITION: ")', async () => {
    st.start = () => new Promise((_res, rej) => { st.release = () => rej(new Error('StartSession: 9 FAILED_PRECONDITION: ')); });
    const p = connect(req);
    await tick();
    await cancelConnect();
    const r = await p;
    expect(r.code).toBe('cancelled');
    expect(st.state.conn.phase).toBe('idle');
    expect(st.state.lastConnectError).toMatchObject({ code: 'cancelled' });
  });

  it('a Cancel that lands just after the start succeeded takes the session down and settles its deposit', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    st.start = () => new Promise((res) => { resolve = res; });
    const p = connect(req);
    await tick();
    await cancelConnect(); // dvpnd had nothing to stop yet
    resolve(session); // ...then its start finished anyway
    const r = await p;
    expect(r.code).toBe('cancelled');
    expect(st.stops).toEqual(['', 'S1']);
    expect(st.settled).toEqual(['Chan1']);
    expect(st.state.session).toBeNull();
    expect(st.state.conn.phase).toBe('idle');
    expect(st.state.lastConnectError).toMatchObject({ code: 'cancelled', action: 'Connect again' });
  });
});
