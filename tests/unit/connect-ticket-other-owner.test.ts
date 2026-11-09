// ─── Q0279: a plan ticket issued to another wallet gets plain words, not the catch-all ───
import { describe, expect, it } from 'vitest';
import { connectErrorCopy } from '../../src/core/session/state';

// Shape from the guest dvpnd.log (M-plan-a3a4 run 2, 2026-10-29).
const RAW = 'rpc error: code = FailedPrecondition desc = ticket was issued for another owner';

describe('connect error: ticket for another owner (Q0279)', () => {
  it('names the wallet mismatch and does not offer Retry', () => {
    const c = connectErrorCopy(RAW);
    expect(c.code).toBe('ticket-other-owner');
    expect(c.retry).toBe(false);
    expect(c.message).toMatch(/another wallet/);
    expect(c.message).not.toMatch(/something went wrong/i);
    expect(c.action).toBe('Set up device');
  });

  it('other errors are unchanged (negative control)', () => {
    expect(connectErrorCopy('rpc error: code = Unknown desc = boom').code).toBe('unknown');
    expect(connectErrorCopy('ticket expired').code).not.toBe('ticket-other-owner');
  });
});
