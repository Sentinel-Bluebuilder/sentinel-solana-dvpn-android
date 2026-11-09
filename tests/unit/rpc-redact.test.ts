// RPC URLs shown in the app hide API keys with the literal marker <redacted> (never %3C…%3E),
// because saving settings recognises an unchanged URL by that marker (src/main/ipc.ts).
import { describe, expect, it } from 'vitest';
import { redactUrl } from '../../src/core/chain/rpc';

describe('redactUrl', () => {
  it('query keys become the literal marker, not percent-encoded', () => {
    expect(redactUrl('https://devnet.helius-rpc.com/?api-key=0123456789abcdef')).toBe('https://devnet.helius-rpc.com/?<redacted>');
    expect(redactUrl('https://devnet.helius-rpc.com/?api-key=x')).not.toMatch(/%3C|%3E/);
  });
  it('a long key in the path is hidden too', () => {
    expect(redactUrl('https://rpc.example.org/v2/AbCdEfGhIjKlMnOpQrStUvWx')).toBe('https://rpc.example.org/v2/<redacted>');
  });
  it('credentials in the URL are dropped; plain URLs stay as they are', () => {
    expect(redactUrl('https://user:pass@rpc.example.org:8899/')).toBe('https://rpc.example.org:8899/');
    expect(redactUrl('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com/');
  });
  it('the save path recognises a redacted URL coming back unchanged', () => {
    expect(redactUrl('https://x.example/?k=1').includes('<redacted>')).toBe(true);
  });
});
