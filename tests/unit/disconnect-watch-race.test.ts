// W5d-b: the WatchSession stream reports the session closed while stopSession is still tearing the
// tunnel down. That update must not flip the view to "Not connected" before Disconnect has confirmed
// the daemon list and direct internet.
import { describe, it, expect, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  session: null as unknown,
  phase: '',
  phases: [] as string[],
  onUpdate: null as null | ((s: unknown) => void),
}));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => ({ session: seen.session }),
  patch: (p: { session?: unknown; conn?: { phase: string } }) => {
    if ('session' in p) seen.session = p.session;
    if (p.conn) { seen.phase = p.conn.phase; seen.phases.push(p.conn.phase); }
  },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
const closed = { id: 's1', node: 'N', service: 'wireguard', status: 'closed', channel: '' };
vi.mock('../../src/main/services/stop-session', () => ({
  stopLiveOrCurrent: async () => {
    seen.onUpdate?.(closed); // the stream's "closed" arrives before stop returns
    return { session: null, dnsRevertFailed: false };
  },
}));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: () => ({
    stopSession: async () => ({ killSwitchReleased: false }),
    listSessions: async () => (seen.session ? [{ id: 's1', node: 'N', service: 'wireguard', status: 'active', channel: '' }] : []),
    watchSession: (_id: string, cb: (s: unknown) => void) => { seen.onUpdate = cb; return () => undefined; },
  }),
  daemonInfo: () => ({ reachable: true }),
}));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ settleChannelSoon: vi.fn(), settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { dnsServers: [] } }), splitForSession: vi.fn() }));

const { disconnect, adoptRunningSession } = await import('../../src/main/services/connection');

describe('disconnect view vs the watch stream (W5d-b)', () => {
  it('a "closed" stream update during stopSession does not show Not connected early', async () => {
    seen.session = { id: 's1', node: 'N', service: 'wireguard', channel: '' };
    await adoptRunningSession();
    expect(seen.onUpdate).not.toBeNull();
    seen.phases.length = 0;
    seen.session = { id: 's1', node: 'N', service: 'wireguard', channel: '' };
    // listSessions answers empty once the session is cleared by ended()
    const r = await disconnect();
    expect(r.ok).toBe(true);
    // idle must appear exactly once, and last: after the daemon list and direct internet confirmed
    expect(seen.phases.filter((p) => p === 'idle')).toHaveLength(1);
    expect(seen.phases[seen.phases.length - 1]).toBe('idle');
    expect(seen.phases.indexOf('idle')).toBe(seen.phases.length - 1);
  });
});
