// ─── safeStorage KeyStore (desktop app) ───
// Ported from sentinel-node-manager-solana services/wallet.ts: refuse to store
// the key when the OS cannot encrypt it.
import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Keypair } from '@solana/web3.js';
import { keypairFromInput, keypairToJson } from '../../core/wallet/keys';
import type { KeyStore } from '../host';
import { log } from '../logger';

export function safeStorageKeyStore(dataDir: string): KeyStore {
  const file = path.join(dataDir, 'wallet.secret');
  const requireEncryption = (): void => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot safely store your wallet key. Sign in to your Windows account and try again.');
  };
  return {
    kind: 'safeStorage',
    exists: () => fs.existsSync(file),
    load(): Keypair | null {
      if (!fs.existsSync(file)) return null;
      requireEncryption();
      try {
        return keypairFromInput(safeStorage.decryptString(fs.readFileSync(file)));
      } catch (err) {
        log.error('wallet: stored key could not be decrypted', err);
        throw new Error('Your stored wallet could not be unlocked on this Windows account.');
      }
    },
    save(kp) {
      requireEncryption();
      fs.writeFileSync(file, safeStorage.encryptString(keypairToJson(kp)));
    },
    remove() {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
  };
}
