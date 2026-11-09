import { describe, expect, it } from 'vitest';
import { KEY_MASK, maskRpcKey, unmaskRpcUrls } from '../../src/shared/rpc-mask';

const KEYED = 'https://devnet.helius-rpc.com/?api-key=0123456789abcdef';

describe('RPC key masking (Settings shows no API keys)', () => {
  it('hides the key and keeps the rest of the URL', () => {
    const m = maskRpcKey(KEYED);
    expect(m).toBe(`https://devnet.helius-rpc.com/?api-key=${KEY_MASK}`);
    expect(m).not.toContain('0123456789abcdef');
  });

  it('leaves URLs without a key alone', () => {
    expect(maskRpcKey('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com');
  });

  it('masks other key spellings', () => {
    expect(maskRpcKey('https://x.example/rpc?foo=1&token=abc')).toBe(`https://x.example/rpc?foo=1&token=${KEY_MASK}`);
    expect(maskRpcKey('https://x.example/?apikey=abc')).toBe(`https://x.example/?apikey=${KEY_MASK}`);
  });

  it('an unchanged masked line saves the stored URL; an edited one saves what was typed', () => {
    const stored = [KEYED, 'https://api.devnet.solana.com'];
    expect(unmaskRpcUrls([maskRpcKey(KEYED), 'https://api.devnet.solana.com'], stored)).toEqual(stored);
    expect(unmaskRpcUrls(['https://devnet.helius-rpc.com/?api-key=newkey'], stored)).toEqual(['https://devnet.helius-rpc.com/?api-key=newkey']);
  });
});
