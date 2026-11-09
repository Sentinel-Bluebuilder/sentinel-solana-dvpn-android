// ─── IDL + network identity ───
// Ported from plans-solana lib/solana/idl.js. The one place that knows which
// network the app talks to, which IDL describes it, and the ACCOUNT SIZES THE
// CHAIN ACTUALLY HOLDS.
//
// Since 11-02 the devnet program is upstream cb33092e (public as 26de5240, same code).
// dvpn.devnet.json is that commit's sentinel-programs/idl/dvpn.json unchanged (cb33 added
// rent-recipient args to every open and renamed every rent_payer field to rent_recipient, same
// type and offset, so the sizes below did not change). Re-check the sizes against live devnet
// accounts after any redeploy: decoding with a wrong layout fails SILENTLY (docs/14).
import { PublicKey } from '@solana/web3.js';
import devnetIdl from './idl/dvpn.devnet.json';

export const NETWORK = 'devnet';
export const PROGRAM_ID = new PublicKey('J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs');
export const MINT = new PublicKey('Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa');
export const EXPLORER_CLUSTER = 'devnet';
export const TOKEN_DECIMALS = 6;

// Anchor's Idl type is structural; the JSON import is wide enough to satisfy it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyIdl = any;

let idlCache: AnyIdl | null = null;
export function loadIdl(): AnyIdl {
  if (idlCache) return idlCache;
  const idl = JSON.parse(JSON.stringify(devnetIdl));
  idl.address = PROGRAM_ID.toBase58();
  idlCache = idl;
  return idl;
}

export type AccountName =
  | 'channel' | 'config' | 'grant' | 'lease' | 'node' | 'nodeUnbonding'
  | 'plan' | 'provider' | 'providerUnbonding' | 'subscription' | 'user';

/** camelCase account name → bytes the chain holds (incl. 8-byte discriminator). */
export const DEPLOYED_SIZES: Record<AccountName, number> = {
  channel: 299,
  config: 277,
  grant: 201,
  lease: 331,
  node: 337,
  nodeUnbonding: 153,
  plan: 155,
  provider: 313,
  providerUnbonding: 153,
  subscription: 198,
  user: 117,
};

const PASCAL: Record<AccountName, string> = {
  channel: 'Channel',
  config: 'Config',
  grant: 'Grant',
  lease: 'Lease',
  node: 'Node',
  nodeUnbonding: 'NodeUnbonding',
  plan: 'Plan',
  provider: 'Provider',
  providerUnbonding: 'ProviderUnbonding',
  subscription: 'Subscription',
  user: 'User',
};

/** 8-byte Anchor discriminator for a camelCase account name. */
export function discriminator(name: AccountName): Buffer {
  const pascal = PASCAL[name];
  const acc = loadIdl().accounts.find((a: { name: string }) => a.name === pascal);
  if (!acc) throw new Error(`IDL has no account ${pascal}`); // copy:internal
  return Buffer.from(acc.discriminator);
}

// ─── Byte offsets used by memcmp filters (8-byte discriminator included) ───
export const OFFSETS = {
  plan: { provider: 40 },
  provider: { owner: 40 },
  subscription: { owner: 8, plan: 40, provider: 72 },
  lease: { provider: 40, node: 72 },
  node: { owner: 40 },
  user: { owner: 8 },
  grant: { granter: 8, grantee: 40, target: 72 },
  // Channel: channel_id[32] @8, owner @40, node @72, opener @104
  channel: { owner: 40, node: 72, opener: 104 },
} as const;

// ─── Program constants (sentinel-solana docs/03-PROGRAM-REFERENCE.md) ───
export const STATUS_LISTED = 1;
export const MODE_VOUCHER = 0;
export const MODE_STREAM = 1;
export const CHANNEL_STATUS_OPEN = 0;
export const CHANNEL_STATUS_CLOSING = 1;

// ─── Grant permissions (crates/dvpn/core/src/permissions.rs) ───
// Signing node / provider metadata (sentinel-go-sdk program.go: PermSignNodeMetadata = PermUpdateNode,
// PermSignProviderMetadata = PermUpdateProvider).
export const PERM_SIGN_NODE_METADATA = 0x2;
export const PERM_SIGN_PROVIDER_METADATA = 0x100;
export const PERM_OPEN_CHANNEL = 1 << 24;
export const PERM_FUND_CHANNELS = 1 << 25;
export const PERM_START_CLOSE_CHANNEL = 1 << 26;
export const PERM_CLOSE_CHANNEL = 1 << 27;
export const PERM_OPEN_SUBSCRIPTION = 1 << 29;
/** What dvpnd's client role checks at startup (go-sdk program.PermsClient) = 788529152. */
export const PERMS_CLIENT = PERM_OPEN_CHANNEL + PERM_FUND_CHANNELS + PERM_START_CLOSE_CHANNEL
  + PERM_CLOSE_CHANNEL + PERM_OPEN_SUBSCRIPTION;

// The bit table lives with the other cb33 facts (core/daemon/layout.ts).
import { PROTOCOL_BITS } from '../daemon/layout';
export { PROTOCOL_BITS };

export function protocolNames(mask: number): string[] {
  return PROTOCOL_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
}
