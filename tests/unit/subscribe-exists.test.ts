// ─── H1: a second subscribe to a plan (AccountAlreadyInUse) says how to fix it ───
import { describe, it, expect } from 'vitest';
import { ProgramError } from '../../src/core/chain/errors';

describe('ProgramError: subscription already exists (H1)', () => {
  const logs = ['Program 11111111111111111111111111111111 invoke [2]', 'Allocate: account Address { address: X, base: None } already in use', 'Program 11111111111111111111111111111111 failed: custom program error: 0x0'];
  it('tells the user an ended subscription must be removed first, not that it "expires"', () => {
    const e = new ProgramError({ logs, message: 'failed' }, { logs });
    expect(e.message).toMatch(/already has a subscription to this plan/);
    expect(e.message).toMatch(/remove it/);
    expect(e.message).not.toMatch(/until it expires/);
  });
  it('leaves other program-0 failures alone', () => {
    const e = new ProgramError({ logs: ['custom program error: 0x0'], message: 'failed' }, { logs: ['custom program error: 0x0'] });
    expect(e.message).not.toMatch(/subscription/);
  });
});
