// ─── A reconnect that comes back as a NEW session is followed as the same one (DIR/QA 10-30) ───
// QA (fedora, wg, kill switch on, cut lifted 5 s into the redial, dvpnd 5555c51): dvpnd recovered the
// session as 01a41c05; the app cleared 13aa004c ("the shown session is no longer running…; clearing it
// (Q0361)"), toasted "The connection to this server stopped working.", and reset the timer. dvpnd now
// links them: replaced_by on the old session's last event / row, replaces + chain_started_unix on the new.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  session: null as null | { id: string; startedAt: number | null; rxBytes: string; txBytes: string; spent: string },
  phase: 'idle',
  list: [] as Array<Record<string, unknown>>,
  watched: [] as string[],
  watchers: [] as Array<(s: Record<string, unknown>) => void>,
  toast: vi.fn(),
  follow: vi.fn(),
}));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => ({ session: st.session, conn: { phase: st.phase } }),
  patch: (p: { session?: unknown; conn?: { phase: string } }) => {
    if ('session' in p) st.session = p.session as typeof st.session;
    if (p.conn) st.phase = p.conn.phase;
  },
  setSplitInEffect: vi.fn(),
  setRedialFollow: st.follow,
  toast: st.toast,
}));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: () => ({
    listSessions: async () => st.list,
    watchSession: (id: string, onUpdate: (s: Record<string, unknown>) => void) => { st.watched.push(id); st.watchers.push(onUpdate); return () => undefined; },
  }),
  daemonInfo: () => ({ reachable: true }),
}));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ settleChannelSoon: vi.fn(), settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/main/system/tunnels', () => ({ leftoverTunnels: async () => [], rivalVpns: async () => [], removeTunnelServices: async () => undefined }));
vi.mock('../../src/core/quality/reachability', () => ({ internetReachable: async () => true }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { dnsServers: [], killSwitch: 'on' } }), splitForSession: vi.fn() }));

const { adoptRunningSession, reconcileShownSession } = await import('../../src/main/services/connection');

const T0 = 1_761_800_000; // the first session's start (unix s)
const old = (status: string, error = '', extra: Record<string, unknown> = {}) => ({
  id: 'old', node: 'N', service: 'wireguard', channel: 'C', status, error,
  usage: { rxBytes: '289000', txBytes: '1000', seconds: '60' }, spent: '7', startedAt: { seconds: String(T0), nanos: 0 }, ...extra,
});
const next = (extra: Record<string, unknown> = {}) => ({
  id: 'new', node: 'N', service: 'wireguard', channel: 'C', status: 'active', error: '',
  usage: { rxBytes: '5000', txBytes: '200', seconds: '4' }, spent: '1', startedAt: { seconds: String(T0 + 70), nanos: 0 },
  replaces: 'old', chainStartedUnix: String(T0), ...extra,
});
const replacedEnd = () => old('ended', 'replaced by new', { replacedBy: 'new' });
const settle = () => new Promise((r) => setTimeout(r, 0));

function expectFollowed(): void {
  expect(st.session?.id).toBe('new');
  expect(st.session?.startedAt).toBe(T0 * 1000);            // one timer: the chain's first start
  expect(st.session?.rxBytes).toBe(String(289000 + 5000));  // old totals + new
  expect(st.session?.spent).toBe('8');
  expect(st.toast).not.toHaveBeenCalled();                  // no "stopped working"
  expect(st.follow).toHaveBeenLastCalledWith('new');        // app-state holds "Reconnecting" until its IP check
  expect(st.watched.at(-1)).toBe('new');
}

describe('a reconnect that came back as a new session', () => {
  beforeEach(() => {
    st.session = null; st.phase = 'idle'; st.watched = []; st.watchers = [];
    st.toast.mockClear(); st.follow.mockClear();
  });

  it('the old session\'s last event names the new one: followed, same timer, totals carried, no toast', async () => {
    st.list = [old('active')];
    await adoptRunningSession();
    st.watchers.at(-1)!(old('active', 'connection lost; reconnecting'));
    expect(st.phase).toBe('reconnecting');
    st.list = [next(), replacedEnd()];
    st.watchers.at(-1)!(replacedEnd());
    await settle(); await settle();
    expectFollowed();
  });

  it('the periodic check finds the old one gone and the new one naming it: followed, never cleared (Q0361)', async () => {
    st.list = [old('active')];
    await adoptRunningSession();
    st.list = [next()];
    expect(await reconcileShownSession()).toBe(true);
    expectFollowed();
  });

  it('adopt while the old one is shown takes the new one as the same session', async () => {
    st.list = [old('active')];
    await adoptRunningSession();
    st.list = [next(), replacedEnd()];
    await adoptRunningSession({ applyProxy: true, startedElsewhere: true });
    expectFollowed();
  });

  it('a CLI that only finds the new session counts the chain from dvpnd\'s list', async () => {
    st.list = [next(), replacedEnd()];
    await adoptRunningSession();
    expect(st.session?.id).toBe('new');
    expect(st.session?.startedAt).toBe(T0 * 1000);
    expect(st.session?.rxBytes).toBe(String(289000 + 5000));
  });

  it('control: an older dvpnd (no link) still ends the session with the notice', async () => {
    st.list = [old('active')];
    await adoptRunningSession();
    st.list = [old('ended', 'the connection to this server stopped working')];
    st.watchers.at(-1)!(old('ended', 'the connection to this server stopped working'));
    await settle(); await settle();
    expect(st.session).toBeNull();
    expect(st.toast).toHaveBeenCalled();
    expect(st.follow).not.toHaveBeenCalled();
  });

  it('control: dvpnd gave up (ended, replaced_by empty): the end and its notice stay', async () => {
    st.list = [old('active')];
    await adoptRunningSession();
    st.list = [old('ended', 'the connection to this server stopped working', { replacedBy: '' }), next({ replaces: '' , chainStartedUnix: '0' })];
    st.watchers.at(-1)!(old('ended', 'the connection to this server stopped working', { replacedBy: '' }));
    await settle(); await settle();
    expect(st.session).toBeNull();
    expect(st.toast).toHaveBeenCalled();
  });
});
