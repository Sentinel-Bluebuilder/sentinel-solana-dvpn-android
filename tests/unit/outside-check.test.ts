import { describe, expect, it } from 'vitest';
import { outsideCheck } from '../../src/core/session/checking-watch';

// Q0357 (DIR 10-30): "Checking the connection…" must show however the connect started. A CLI connect
// is found by the app's idle poll; while dvpnd lists it as "checking" the app shows the label without
// adopting it, adopts it once live, and drops the label if the check failed.

describe('connect started elsewhere', () => {
  it('a checking session shows the label once, then keeps it', () => {
    expect(outsideCheck({ status: 'checking' }, false)).toBe('show');
    expect(outsideCheck({ status: 'checking' }, true)).toBe('keep');
  });

  it('a checking session is never adopted as connected', () => {
    expect(outsideCheck({ status: 'checking' }, false)).not.toBe('adopt');
  });

  it('once live it is adopted, whether or not the label was shown', () => {
    expect(outsideCheck({ status: 'active' }, true)).toBe('adopt');
    expect(outsideCheck({ status: 'active' }, false)).toBe('adopt');
  });

  it('a check that failed (nothing listed) clears the label; nothing to do otherwise', () => {
    expect(outsideCheck(undefined, true)).toBe('clear');
    expect(outsideCheck(undefined, false)).toBe('none');
  });
});
