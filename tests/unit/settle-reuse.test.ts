// ─── A reconnect never reuses a deposit the app is closing ───
// ui-win-3 2026-10-22: Disconnect queued a close 15 s later; a Connect at +19 s reused the same
// deposit while start_close was in flight, and the node ended the new session ("position closing").
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/chain/accounts', () => ({ channelsByOwner: async () => [], userByOwner: async () => null }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => null, ownerSigner: vi.fn() }));
vi.mock('../../src/main/logger', () => ({ log: { warn: () => undefined, info: () => undefined, error: () => undefined } }));
vi.mock('../../src/main/daemon/manager', () => ({ daemon: vi.fn(), daemonInfo: () => ({ reachable: false }) }));
vi.mock('../../src/main/app-state', () => ({ patch: vi.fn(), snapshot: () => ({ session: null }), toast: vi.fn() }));
const mod = await import('../../src/main/services/settlement');

describe('claimForReuse', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a close still waiting is cancelled and the deposit is reused', () => {
    mod.settleChannelSoon('A');
    expect(mod.claimForReuse('A')).toBe(true);
    vi.advanceTimersByTime(60_000);
    // Had the timer still fired, A would now be "closing" and refused.
    expect(mod.claimForReuse('A')).toBe(true);
  });

  it('a close that already fired: no reuse (pay a new deposit)', () => {
    mod.settleChannelSoon('B');
    vi.advanceTimersByTime(mod.SETTLE_AFTER_MS + 1);
    expect(mod.claimForReuse('B')).toBe(false);
  });

  it('two minutes after the close fired the chain is the judge again', () => {
    mod.settleChannelSoon('C');
    vi.advanceTimersByTime(mod.SETTLE_AFTER_MS + 1 + 120_000);
    expect(mod.claimForReuse('C')).toBe(true);
  });

  it('a deposit with nothing queued is reusable', () => {
    expect(mod.claimForReuse('D')).toBe(true);
  });

  // Q0411 (QA, DIR): a switch back to the same node minutes later reused nothing: the close fired
  // at +15 s and every return paid a new deposit. The deposit now waits 10 min.
  it('a reconnect a minute later still reuses the deposit', () => {
    mod.settleChannelSoon('E');
    vi.advanceTimersByTime(60_000); // inside the 2 min closing window had a 15 s close fired
    expect(mod.claimForReuse('E')).toBe(true);
  });

  it('a switching-servers end queues no close; other ends do', () => {
    expect(mod.settlesOnEnd('switching servers')).toBe(false);
    expect(mod.settlesOnEnd('Switching servers (node 6ZCH)')).toBe(false);
    expect(mod.settlesOnEnd('stopped by user')).toBe(true);
    expect(mod.settlesOnEnd('closed by client')).toBe(true);
  });
});
