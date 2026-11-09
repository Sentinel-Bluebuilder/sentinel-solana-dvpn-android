import crypto from 'node:crypto';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { Keypair, PublicKey } from '@solana/web3.js';
import { b58decode } from '../chain/b58';

// Ported from sentinel-node-manager-solana src/main/services/keys.ts (+ base58 import
// from plans-solana lib/session.js keypairFromInput).
/**
 * Pure key helpers (no Electron) so they are unit-testable.
 *
 *   • 24-word BIP-39 mnemonics (256-bit entropy).
 *   • SLIP-0010 ed25519 derivation, path m/44'/501'/0'/0' — the Phantom /
 *     Solflare default, so a phrase from this app restores in those wallets.
 *   • solana-keygen JSON (64-byte array) in and out — the format dvpnd and
 *     dvpnctl read, and the format of the funded devnet test key.
 */

export const SOLANA_HD_PATH = "m/44'/501'/0'/0'";

const HARDENED = 0x80000000;

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

/** SLIP-0010 master key + chain code for ed25519. */
export function slip10Master(seed: Uint8Array): { key: Buffer; chainCode: Buffer } {
  const I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** Derive along a fully-hardened path (ed25519 supports hardened only). */
export function slip10Derive(seed: Uint8Array, path: string): Buffer {
  const segments = path.split('/');
  if (segments[0] !== 'm') throw new Error(`The derivation path "${path}" must start with m/, like m/44'/501'/0'/0'.`);
  let { key, chainCode } = slip10Master(seed);
  for (const seg of segments.slice(1)) {
    if (!/^\d+'$/.test(seg)) throw new Error(`Every derivation path segment must be hardened (end with '), unlike "${seg}".`);
    const index = Number(seg.slice(0, -1)) + HARDENED;
    const data = Buffer.alloc(37);
    data[0] = 0;
    key.copy(data, 1);
    data.writeUInt32BE(index >>> 0, 33);
    const I = crypto.createHmac('sha512', chainCode).update(data).digest();
    key = I.subarray(0, 32);
    chainCode = I.subarray(32);
  }
  return key;
}

export function keypairFromMnemonic(phrase: string): Keypair {
  const seed = mnemonicToSeedSync(normalizeMnemonic(phrase), '');
  return Keypair.fromSeed(slip10Derive(seed, SOLANA_HD_PATH));
}

/** Parse a solana-keygen JSON file body (64-byte array). */
export function keypairFromJson(body: string): Keypair {
  let arr: unknown;
  try {
    arr = JSON.parse(body);
  } catch (err) {
    throw new Error(`That key file is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error('That key file is not a Solana key (expected a JSON array of 64 numbers, as written by solana-keygen).');
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}

/** solana-keygen JSON for a keypair — what dvpnd/dvpnctl read from keys/*.json. */
export function keypairToJson(kp: Keypair): string {
  return JSON.stringify(Array.from(kp.secretKey));
}

/** True for a base58 public key on the ed25519 curve (a wallet, not a PDA). */
export function isWalletAddress(addr: string): boolean {
  // Ordinary bad input (typos, wrong length) is answered without throwing or logging.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim())) return false;
  try {
    const pk = new PublicKey(addr.trim());
    return PublicKey.isOnCurve(pk.toBytes());
  } catch (err) {
    console.warn(`[keys] not a wallet address: ${(err as Error).message}`);
    return false;
  }
}

/** Import any common secret form: 12/24-word phrase, solana-keygen JSON, or base58 secret (Phantom export). */
export function keypairFromInput(input: string): Keypair {
  const t = String(input ?? '').trim();
  if (!t) throw new Error('Paste a recovery phrase, a key file, or a private key.');
  if (t.startsWith('[')) return keypairFromJson(t);
  if (/\s/.test(t)) {
    if (!isValidMnemonic(t)) throw new Error('That recovery phrase is not valid. Check the words and their order.');
    return keypairFromMnemonic(t);
  }
  let raw: Uint8Array;
  try {
    raw = b58decode(t);
  } catch (err) {
    throw new Error(`That private key is not valid base58: ${(err as Error).message}`);
  }
  if (raw.length === 64) return Keypair.fromSecretKey(raw);
  if (raw.length === 32) return Keypair.fromSeed(raw);
  throw new Error(`A private key is 64 bytes (got ${raw.length}).`);
}
