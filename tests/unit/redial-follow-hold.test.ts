// ─── A followed reconnect shows "Reconnecting" until its first IP check (DIR/QA 10-30) ───
// QA (fedora, wg lift): the recovered session went straight to "Connected, checking your IP…" after
// a green "Protected" on the dead one. Real app-state: dvpnd says the new session is up, the app holds
// "Reconnecting" until an IP check of THAT session settles what it covers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/main/host', () => ({ getHost: () => ({ emit: () => undefined }) }));

const { patch, snapshot, setRedialFollow, setIpChecksOff } = await import('../../src/main/app-state');
const { viewFor } = await import('../../src/core/session/state');

const NODE = '203.0.113.1';
const session = (id: string) => ({ id, node: 'N', status: 'active', service: 'wireguard', rxBytes: '0', txBytes: '0', seconds: '0', spent: '0', channel: '', proxyEndpoint: '', error: '', warning: '', startedAt: 1 });
const ipOf = (sid: string) => ({ ip: NODE, source: 't', at: Date.now(), sid, nodeIp: NODE });

describe('following a reconnect onto a new session', () => {
  beforeEach(() => {
    setIpChecksOff(false);
    setRedialFollow(null);
    patch({ session: null, conn: viewFor('idle'), publicIp: null, homeIp: '203.0.113.1' });
  });

  it('holds "Reconnecting" through dvpnd\'s updates until the new session\'s IP check, then Protected', () => {
    setRedialFollow('new');
    patch({ session: session('new'), conn: viewFor('connected') });
    expect(snapshot().conn.phase).toBe('reconnecting');
    patch({ session: session('new'), conn: viewFor('connected') }); // a usage update from dvpnd
    expect(snapshot().conn.phase).toBe('reconnecting');
    patch({ publicIp: ipOf('old') });                                // the OLD session's IP does not count
    expect(snapshot().conn.phase).toBe('reconnecting');
    patch({ publicIp: ipOf('new') });
    expect(snapshot().conn.phase).toBe('connected');
    expect(snapshot().conn.title).toBe('Protected');
    patch({ session: session('new'), conn: viewFor('connected') }); // and it stays released
    expect(snapshot().conn.title).toBe('Protected');
  });

  it('a real dvpnd reconnect of the new session is shown as dvpnd says, not lifted by our hold', () => {
    setRedialFollow('new');
    patch({ session: session('new'), conn: viewFor('reconnecting', 'The daemon is retrying the connection.') });
    patch({ publicIp: ipOf('new') });
    expect(snapshot().conn.phase).toBe('reconnecting');
  });

  it('control: no reconnect followed, an unmeasured session is plain "connected" (no hold)', () => {
    patch({ session: session('s'), conn: viewFor('connected') });
    expect(snapshot().conn.phase).toBe('connected');
  });

  it('control: IP checks turned off, no hold (nothing would ever release it)', () => {
    setIpChecksOff(true);
    setRedialFollow('new');
    patch({ session: session('new'), conn: viewFor('connected') });
    expect(snapshot().conn.phase).toBe('connected');
  });
});
