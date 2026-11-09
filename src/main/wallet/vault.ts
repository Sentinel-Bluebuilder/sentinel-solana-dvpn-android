// ─── Owner wallet vault (F2, D10 in-app mode) ───
// The secret lives in the host's KeyStore: Electron safeStorage in the app
// (wallet/electron-keystore.ts), a key file for the CLI. The secret never crosses
// IPC; the renderer only sees the address (and the phrase once, right after
// create, for the backup screen).
import type { Keypair } from '@solana/web3.js';
import { keypairFromInput, keypairFromMnemonic, newMnemonic } from '../../core/wallet/keys';
import { keypairSigner, type OwnerSigner } from '../../core/app/signer';
import { getHost } from '../host';
import { log } from '../logger';

let cached: Keypair | null = null;

export function hasWallet(): boolean {
  return getHost().keyStore.exists();
}

export function ownerKeypair(): Keypair | null {
  if (cached) return cached;
  cached = getHost().keyStore.load();
  return cached;
}

export function ownerAddress(): string | null {
  return ownerKeypair()?.publicKey.toBase58() ?? null;
}

export function ownerSigner(): OwnerSigner {
  const kp = ownerKeypair();
  if (!kp) throw new Error('Set up a wallet first.');
  return keypairSigner(kp);
}

/** Never replace a wallet that is already here: that key may be the only way to its funds. */
function refuseIfWallet(incoming?: string): void {
  // A --keyfile wallet is read-only: its own save() refusal says what to do (unset DVPN_KEYFILE).
  if (getHost().keyStore.kind === 'keyfile') return;
  const cur = ownerAddress();
  if (!cur || cur === incoming) return;
  throw new Error(`A wallet is already set up on this computer (${cur}). Back up its recovery phrase, log out, then try again. Nothing was changed.`);
}

/** New 24-word wallet. Returns the phrase once for the backup screen. */
export function createWallet(): { address: string; mnemonic: string } {
  refuseIfWallet();
  const mnemonic = newMnemonic();
  const kp = keypairFromMnemonic(mnemonic);
  getHost().keyStore.save(kp);
  cached = kp;
  log.info('wallet: created', { address: kp.publicKey.toBase58() });
  return { address: kp.publicKey.toBase58(), mnemonic };
}

/** Import phrase / solana-keygen JSON / base58 secret. */
export function importWallet(input: string): { address: string } {
  const kp = keypairFromInput(input);
  refuseIfWallet(kp.publicKey.toBase58());
  getHost().keyStore.save(kp);
  cached = kp;
  log.info('wallet: imported', { address: kp.publicKey.toBase58() });
  return { address: kp.publicKey.toBase58() };
}

export function logout(): void {
  cached = null;
  getHost().keyStore.remove();
  log.info('wallet: removed from this computer');
}
