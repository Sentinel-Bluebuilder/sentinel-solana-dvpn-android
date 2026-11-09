// ─── Devnet program error numbers ───
// Since the 2026-10-21 redeploy (upstream cf4c372) the chain numbers errors exactly as the
// bundled IDL does. These pins catch a future IDL swap that renumbers silently.
import { describe, expect, it } from 'vitest';
import { describeProgramError, devnetCodeOf } from '../../src/core/chain/errors';

describe('describeProgramError', () => {
  it('channel and grant errors by number', () => {
    expect(describeProgramError(6032).name).toBe('ChannelNotOpen');
    expect(describeProgramError(6033).name).toBe('ChannelNotClosing');
    expect(describeProgramError(6035).name).toBe('GraceNotElapsed');
    expect(describeProgramError(6024).name).toBe('AmountExceedsAllowance');
    expect(describeProgramError(6045).name).toBe('GrantExpired');
    expect(describeProgramError(6046).name).toBe('PermissionNotGranted');
    expect(describeProgramError(6048).name).toBe('InvalidVoucherSigner');
  });
  it('Anchor framework codes', () => {
    expect(describeProgramError(102).name).toBe('InstructionDidNotDeserialize');
  });
  it('devnetCodeOf round-trips names', () => {
    expect(devnetCodeOf('GraceNotElapsed')).toBe(6035);
    expect(devnetCodeOf('PermissionNotGranted')).toBe(6046);
    expect(devnetCodeOf('NoSuchError')).toBeNull();
  });
});

describe('ProgramError: account already in use', () => {
  it('a second subscription (System Program error 0) reads as plain words, not "Program error 0 (0):"', async () => {
    const { ProgramError } = await import('../../src/core/chain/errors');
    const logs = [
      'Program 11111111111111111111111111111111 invoke [2]',
      'Allocate: account Address { address: GpKwDwGMCEoMDZ7MNhWG41VVXbyWV1ZAt7Rt38Azas4i, base: None } already in use',
      'Program 11111111111111111111111111111111 failed: custom program error: 0x0',
    ];
    const e = new ProgramError({ err: { InstructionError: [1, { Custom: 0 }] }, logs });
    expect(e.message).toMatch(/already has a subscription/);
    expect(e.message).not.toMatch(/Program error/);
  });
  it('error 0 without that log line keeps the generic text', async () => {
    const { ProgramError } = await import('../../src/core/chain/errors');
    expect(new ProgramError({ err: { InstructionError: [0, { Custom: 0 }] }, logs: [] }).message).not.toMatch(/already has a subscription/);
  });
});
