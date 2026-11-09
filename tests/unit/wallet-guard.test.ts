// ─── Never replace a wallet that is already on this computer ───
// Regression: the CLI's DPAPI store said kind 'keyfile', so vault.ts skipped its guard and a
// second `wallet create --yes` silently replaced the first wallet (VM sweep 2026-10-21).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { setHost, type KeyStore } from '../../src/main/host';
import { createWallet, importWallet, logout, ownerAddress } from '../../src/main/wallet/vault';
import { cliKeyStore } from '../../src/cli/keystore';
import { keypairToJson } from '../../src/core/wallet/keys';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvpn-wguard-'));

function memoryStore(kind: KeyStore['kind']): KeyStore {
  let kp: Keypair | null = null;
  return { kind, exists: () => kp !== null, load: () => kp, save: (k) => { kp = k; }, remove: () => { kp = null; } };
}
function useStore(store: KeyStore): void {
  setHost({ name: 'cli', resourcesDir: '.', dataDir: dir, emit: () => undefined, keyStore: store });
}

describe('wallet guard', () => {
  beforeEach(() => {
    useStore(memoryStore('dpapi'));
    logout();
  });

  it('the CLI encrypted store is not reported as a read-only key file', () => {
    expect(cliKeyStore(dir).kind).toBe('dpapi');
    expect(cliKeyStore(dir, path.join(dir, 'k.json')).kind).toBe('keyfile');
  });

  for (const kind of ['dpapi', 'safeStorage', 'memory'] as const) {
    it(`a second create is refused and keeps the first wallet (${kind})`, () => {
      useStore(memoryStore(kind));
      logout();
      const first = createWallet().address;
      expect(() => createWallet()).toThrow(/already set up on this computer.*Nothing was changed/);
      expect(ownerAddress()).toBe(first);
    });
  }

  it('importing a different wallet over one is refused; the same one is fine', () => {
    const first = createWallet().address;
    const other = Keypair.generate();
    expect(() => importWallet(keypairToJson(other))).toThrow(/already set up/);
    expect(ownerAddress()).toBe(first);
  });

  it('after logout a new wallet can be created', () => {
    const first = createWallet().address;
    logout();
    expect(createWallet().address).not.toBe(first);
  });
});
