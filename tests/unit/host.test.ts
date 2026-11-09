import { describe, expect, it } from 'vitest';
import { validHost } from '../../src/core/net/host';
import { isValidRpcUrl } from '../../src/core/chain/rpc';
import { wholeFlag } from '../../src/core/daemon/flags';

// ─── the Android app settings-e2e findings: hosts that can never resolve, prepay back to 0 ───
describe('validHost', () => {
  it('accepts names and IPs', () => {
    for (const h of ['api.devnet.solana.com', 'localhost', '127.0.0.1', '[::1]', 'a-b.c']) expect(validHost(h)).toBe(true);
  });
  it('refuses junk hosts that URL accepts', () => {
    for (const h of ['x"y', '', 'a..b', '-a.com', 'a_b.com', 'x y']) expect(validHost(h)).toBe(false);
  });
  it('rpc urls with a junk host are refused', () => {
    expect(isValidRpcUrl('https://x"y')).toBe(false);
    expect(isValidRpcUrl('https://api.devnet.solana.com')).toBe(true);
  });
});

describe('wholeFlag', () => {
  it('accepts 0 (back to the node minimum) and refuses junk', () => {
    expect(wholeFlag('prepay-mb', '0', 1_000_000n)).toBe('0');
    expect(wholeFlag('prepay-mb', '5', 1_000_000n)).toBe('5000000');
    expect(() => wholeFlag('prepay-mb', '-1', 1n)).toThrow(/whole number/);
    expect(() => wholeFlag('prepay-mb', '1.5', 1n)).toThrow(/whole number/);
  });
});
