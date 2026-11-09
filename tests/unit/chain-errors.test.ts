import { describe, expect, it } from 'vitest';
import { extractErrorCode } from '../../src/core/chain/errors';

// Found by the standards-audit session while building the builder kit on src/core.
describe('extractErrorCode', () => {
  it('reads a bare transaction error object (simulation value.err)', () => {
    expect(extractErrorCode({ InstructionError: [0, { Custom: 102 }] })).toBe(102);
  });
  it('still reads logs, hex codes and wrapped errors', () => {
    expect(extractErrorCode({ logs: ['Program log: AnchorError ... Error Number: 6001. Error Message: paused'] })).toBe(6001);
    expect(extractErrorCode({ message: 'failed: custom program error: 0x1771' })).toBe(6001);
    expect(extractErrorCode({ err: { InstructionError: [1, { Custom: 7 }] } })).toBe(7);
    expect(extractErrorCode({ message: 'no code here' })).toBeNull();
  });
});
