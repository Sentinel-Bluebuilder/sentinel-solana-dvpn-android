// ─── Anchor program + PDAs + config cache ───
// Ported from plans-solana lib/solana/program.js. Every PDA that depends on an
// on-chain account is passed EXPLICITLY so building an instruction never triggers
// a hidden RPC fetch.
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import { PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { loadIdl, PROGRAM_ID, MINT } from './idl';
import { rpcCall, sendConnection } from './rpc';

export { BN };

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(t: T): Promise<T> => t,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(t: T[]): Promise<T[]> => t,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProgram = Program<any>;
let programCache: AnyProgram | null = null;

/** Program used only to build instructions and decode accounts. */
export function getProgram(): AnyProgram {
  if (programCache) return programCache;
  const provider = new AnchorProvider(sendConnection(), READ_ONLY_WALLET, { commitment: 'confirmed' });
  programCache = new Program(loadIdl(), provider);
  return programCache;
}

export function coder(): AnyProgram['coder']['accounts'] {
  return getProgram().coder.accounts;
}

// ─── PDAs ───
const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
export type KeyLike = PublicKey | string;
export const key = (k: KeyLike): PublicKey => (k instanceof PublicKey ? k : new PublicKey(k));
export const id32 = (b: Buffer | Uint8Array | number[]): Buffer => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (buf.length !== 32) throw new Error(`id must be 32 bytes, got ${buf.length}`); // copy:internal
  return buf;
};

function find(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

export const pda = {
  config: (): PublicKey => find([enc('config')]),
  plan: (provider: KeyLike, planId: Buffer): PublicKey => find([enc('plan'), key(provider).toBuffer(), id32(planId)]),
  subscription: (owner: KeyLike, plan: KeyLike): PublicKey => find([enc('subscription'), key(owner).toBuffer(), key(plan).toBuffer()]),
  node: (owner: KeyLike, nodeId: Buffer): PublicKey => find([enc('node'), key(owner).toBuffer(), id32(nodeId)]),
  user: (owner: KeyLike): PublicKey => find([enc('user'), key(owner).toBuffer()]),
  channel: (owner: KeyLike, channelId: Buffer): PublicKey => find([enc('channel'), key(owner).toBuffer(), id32(channelId)]),
  /** Grant from `granter` to `grantee`; target default = every account of the granter. */
  grant: (granter: KeyLike, grantee: KeyLike, target: KeyLike = PublicKey.default): PublicKey =>
    find([enc('grant'), key(granter).toBuffer(), key(grantee).toBuffer(), key(target).toBuffer()]),
};

/** Token-2022 associated token account for `owner` on the dVPN mint. */
export function ata(owner: KeyLike): PublicKey {
  return getAssociatedTokenAddressSync(MINT, key(owner), true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

// ─── Config (vault / treasury / params) — cached, it only changes by governance ───
export interface ChainConfig {
  address: PublicKey;
  vault: PublicKey;
  treasury: PublicKey;
  mint: PublicKey;
  feeBps: number;
  channelCloseGraceSeconds: number;
  nodeListingTtlSeconds: number;
  paused: number;
}

let configCache: ChainConfig | null = null;
let configAt = 0;
let configLoading: Promise<ChainConfig> | null = null;
/** Callers that arrive while a read is in flight share it (startup asked twice at once, T5). */
export function fetchConfig({ maxAgeMs = 10 * 60_000 } = {}): Promise<ChainConfig> {
  if (configCache && Date.now() - configAt < maxAgeMs) return Promise.resolve(configCache);
  if (!configLoading) configLoading = loadConfig().finally(() => { configLoading = null; });
  return configLoading;
}

async function loadConfig(): Promise<ChainConfig> {
  const addr = pda.config();
  const info = await rpcCall((c) => c.getAccountInfo(addr, 'confirmed'), { label: 'config' });
  if (!info) throw new Error(`Config account ${addr.toBase58()} not found on ${PROGRAM_ID.toBase58()}`);
  const raw = coder().decode('config', info.data);
  configCache = {
    address: addr,
    vault: raw.vault,
    treasury: raw.treasury,
    mint: raw.mint,
    feeBps: Number(raw.feeBps),
    channelCloseGraceSeconds: Number(raw.channelCloseGraceSeconds),
    nodeListingTtlSeconds: Number(raw.nodeListingTtlSeconds),
    paused: Number(raw.pausedMask ?? 0), // IDL field paused_mask (raw.paused was always NaN)
  };
  configAt = Date.now();
  return configCache;
}

export { PROGRAM_ID, MINT };
