import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { setHost } from '../../src/main/host';
import { createWallet, importWallet, logout, ownerAddress } from '../../src/main/wallet/vault';

// A wallet already on this computer may be the only way to its funds: create / import must
// never replace it (sweep 2026-10-20 found `wallet create` silently overwrote it).
let stored: Keypair | null = null;
beforeEach(() => {
  stored = null;
  setHost({
    name: 'cli', resourcesDir: '.', dataDir: '.', emit: () => undefined,
    keyStore: { kind: 'memory', exists: () => !!stored, load: () => stored, save: (kp) => { stored = kp; }, remove: () => { stored = null; } },
  });
  try { logout(); } catch (err) { expect(String(err)).toBeTruthy(); }
});

describe('wallet vault never replaces a wallet', () => {
  it('create refuses when a wallet exists and keeps the old key', () => {
    const first = createWallet().address;
    expect(() => createWallet()).toThrow(/already set up.*Nothing was changed/);
    expect(ownerAddress()).toBe(first);
  });
  it('import of a different key refuses; the same key is fine', () => {
    const first = createWallet().address;
    const other = Keypair.generate();
    expect(() => importWallet(JSON.stringify(Array.from(other.secretKey)))).toThrow(/already set up/);
    expect(ownerAddress()).toBe(first);
  });
  it('after logout a new wallet can be created', () => {
    createWallet();
    logout();
    expect(ownerAddress()).toBeNull();
    expect(createWallet().address).toBeTruthy();
  });
});
