// ─── Q0280: the VPN service stopping mid-settle is a deferral, not an error ───
// wx4 edge:shutdown-during-settle: app.log had ERROR 'settlement failed {err: ListSessions: Connection
// dropped}'. Settle stops without closing anything and runs again later; the log says warn.
import { describe, expect, it } from 'vitest';
import { daemonWentAway } from '../../src/core/settlement/settlement';

const daemonError = (kind: string, message: string) => Object.assign(new Error(message), { name: 'DaemonError', kind });

describe('daemonWentAway (Q0280)', () => {
  it('the wx4 shutdown line is a deferral', () => {
    expect(daemonWentAway(daemonError('unavailable', 'ListSessions: Connection dropped'))).toBe(true);
    expect(daemonWentAway(daemonError('timeout', 'ListChannels: Deadline exceeded'))).toBe(true);
    expect(daemonWentAway(new Error('ListSessions: Connection dropped'))).toBe(true);
    expect(daemonWentAway(new Error('ListChannels: 14 UNAVAILABLE: No connection established'))).toBe(true);
  });

  it('chain and other daemon failures stay errors', () => {
    expect(daemonWentAway(daemonError('internal', 'ListSessions: database is locked'))).toBe(false);
    expect(daemonWentAway(daemonError('permission', 'ListSessions: access is denied'))).toBe(false);
    expect(daemonWentAway(new Error('Transaction simulation failed: custom program error: 0x1771'))).toBe(false);
    expect(daemonWentAway(new Error('fetch failed: ECONNREFUSED api.devnet.solana.com'))).toBe(false);
    expect(daemonWentAway(null)).toBe(false);
  });
});
