// Q0361 (ddv-fix-and 2026-10-30, 4th CLI connect/disconnect with the app open): the app adopted the
// CLI's session while the CLI was disconnecting it and missed the end, so it kept "Connected, but
// traffic is not going through the VPN" and blocked Connect. The session poll checks the shown
// session against dvpnd's list and clears one dvpnd no longer runs.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const seen = vi.hoisted(() => ({
  session: null as null | { id: string },
  phase: 'connected',
  list: [] as Array<{ id: string; status: string; error?: string }>,
}));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/main/app-state', () => ({
  snapshot: () => ({ session: seen.session, conn: { phase: seen.phase } }),
  patch: (p: { session?: unknown; conn?: { phase: string } }) => {
    if ('session' in p) seen.session = p.session as { id: string } | null;
    if (p.conn) seen.phase = p.conn.phase;
  },
  setSplitInEffect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: () => ({
    listSessions: async () => seen.list.map((s) => ({ node: 'N', service: 'wireguard', channel: '', ...s })),
    watchSession: () => () => undefined,
  }),
  daemonInfo: () => ({ reachable: true }),
}));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/main/services/history', () => ({ recordStart: vi.fn(), recordEnd: vi.fn() }));
vi.mock('../../src/main/services/settlement', () => ({ settleChannelSoon: vi.fn(), settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/main/system/dns-check', () => ({ dnsReallyLeftOver: async () => false, flushDnsCache: vi.fn() }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { dnsServers: [] } }), splitForSession: vi.fn() }));

const { reconcileShownSession, runningSession, blockedAfterEnd } = await import('../../src/main/services/connection');
const { closeReasonCopy } = await import('../../src/core/session/state');

// Q0366 pass 2 (port of the Linux app 3044f7e6): after dvpnd gave up, the blocked screen showed only the general text.
describe('the blocked-internet copy after a session ended on its own', () => {
  it('keeps dvpnd\'s reason and its next step, and offers Restore network', () => {
    const msg = blockedAfterEnd(closeReasonCopy('the connection to this server stopped working'));
    expect(msg).toMatch(/^The connection to this server stopped working\./);
    expect(msg).toContain('pick another server, or press Restore network');
    expect(msg).toMatch(/\.$/);
  });
  it('without a reason it is the general blocked copy (Android: the held-interface text)', () => {
    expect(blockedAfterEnd(null)).toMatch(/^Your internet is not working/);
    expect(blockedAfterEnd(null, 'held text')).toBe('held text');
    expect(blockedAfterEnd(closeReasonCopy('the connection to this server stopped working'), 'held text')).toMatch(/^The connection to this server stopped working\./);
  });
});

describe('the shown session vs what dvpnd runs (Q0361)', () => {
  beforeEach(() => {
    seen.session = { id: 's1' };
    seen.phase = 'connected';
  });

  it('a session dvpnd ended (end not seen) is cleared on the second look', async () => {
    seen.list = [{ id: 's1', status: 'ended', error: 'closed by client' }];
    expect(await reconcileShownSession()).toBe(false); // one miss: maybe between dvpnd steps
    expect(seen.session).not.toBeNull();
    expect(await reconcileShownSession()).toBe(true);
    expect(seen.session).toBeNull();
    expect(seen.phase).toBe('idle');
  });

  it('a session dvpnd no longer lists at all is cleared too', async () => {
    seen.list = [];
    await reconcileShownSession();
    expect(await reconcileShownSession()).toBe(true);
    expect(seen.session).toBeNull();
  });

  it('dvpnd running a different session (new id): the old one is cleared, the running one adopted', async () => {
    seen.list = [{ id: 's1', status: 'ended' }, { id: 's2', status: 'active' }];
    await reconcileShownSession();
    expect(await reconcileShownSession()).toBe(true);
    expect(seen.session?.id).toBe('s2');
  });

  it('negative controls: a running session, or a view that is not plainly connected, is left alone', async () => {
    seen.list = [{ id: 's1', status: 'active' }];
    for (let i = 0; i < 3; i++) expect(await reconcileShownSession()).toBe(false);
    expect(seen.session?.id).toBe('s1');

    seen.list = [];
    for (const phase of ['connecting', 'disconnecting', 'checking']) {
      seen.phase = phase;
      for (let i = 0; i < 3; i++) expect(await reconcileShownSession()).toBe(false);
      expect(seen.session?.id).toBe('s1');
    }
  });

  // Q0366 (TAN lab-q0366b): dvpnd gave up reconnecting, the app stayed on "Reconnecting" for minutes.
  it('reconnecting: kept while dvpnd still lists it running, cleared once dvpnd gave up', async () => {
    seen.phase = 'reconnecting';
    seen.list = [{ id: 's1', status: 'active', error: 'connection lost; reconnecting' }];
    for (let i = 0; i < 3; i++) expect(await reconcileShownSession()).toBe(false);
    expect(seen.session?.id).toBe('s1');

    seen.list = [{ id: 's1', status: 'ended', error: 'the connection to this server stopped working' }];
    await reconcileShownSession();
    expect(await reconcileShownSession()).toBe(true);
    expect(seen.session).toBeNull();
    expect(seen.phase).toBe('idle');
  });

  // Q0366 pass 2 (QA fedora, wg cut): dvpnd lists the redial attempt first (its stored row "active"
  // before its tunnel check, or its live copy "checking"); the app swapped to it, a green "Connected"
  // with the timer reset. The redial belongs to the shown connection: Reconnecting stays.
  it('during a redial the attempt listed first never replaces the shown session', async () => {
    seen.phase = 'reconnecting';
    for (const list of [
      [{ id: 'a1', status: 'active' }, { id: 's1', status: 'active', error: 'connection lost; reconnecting' }],
      [{ id: 'a1', status: 'checking' }, { id: 's1', status: 'active' }],
    ]) {
      seen.list = list;
      for (let i = 0; i < 3; i++) expect(await reconcileShownSession()).toBe(false);
      expect(seen.session?.id).toBe('s1');
      expect(seen.phase).toBe('reconnecting');
    }
  });

  it('the live copy wins over an attempt\'s stored row when picking the running session', () => {
    const r = (id: string, status: string, error = '') => ({ id, status, error, node: 'N', service: 'wireguard' }) as never;
    expect(runningSession([r('a1', 'active'), r('s1', 'active', 'connection lost; reconnecting')])?.id).toBe('s1');
    expect(runningSession([r('s1', 'active'), r('a1', 'checking')])?.id).toBe('a1');
    expect(runningSession([r('s0', 'ended'), r('s2', 'active')])?.id).toBe('s2');
    expect(runningSession([r('s0', 'ended')])).toBeUndefined();
  });

  it('a miss followed by the session running again starts the count over', async () => {
    seen.list = [];
    await reconcileShownSession();
    seen.list = [{ id: 's1', status: 'active' }];
    await reconcileShownSession();
    seen.list = [];
    expect(await reconcileShownSession()).toBe(false);
    expect(seen.session?.id).toBe('s1');
  });
});
