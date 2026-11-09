// Ported from linux-app 46754684 (builder-kb, 10-23).
import { describe, it, expect } from 'vitest';
import { parseArgs, whole, UsageError } from '../../src/cli/args';

// Edge run 2026-10-22: `connect <node> --units 0 --yes` paid for a session; bad numbers must be usage errors.
describe('whole-number CLI flags', () => {
  const units = (v: string): number => whole(parseArgs(['connect', 'X', '--units', v]), 'units', 1, 1, 1000);

  it('accepts whole numbers in range and the fallback when absent', () => {
    expect(units('1')).toBe(1);
    expect(units('1000')).toBe(1000);
    expect(whole(parseArgs(['connect', 'X']), 'units', 7, 1, 1000)).toBe(7);
  });

  it.each(['0', '-5', '1.5', '1e3', '１', '1001', '99999999999999999999', '', ' 3', 'NaN', '0x10'])('refuses --units %j', (v) => {
    expect(() => units(v)).toThrow(UsageError);
  });
});
