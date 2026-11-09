// ─── Account readers ───
// Ported from plans-solana lib/solana/accounts.js. Chain is the database. Every
// reader is getProgramAccounts with an explicit DEPLOYED dataSize + discriminator
// memcmp (+ caller memcmps), decoded under the devnet IDL, normalised to plain
// JSON: pubkeys base58, u64 base-unit strings, ids hex, byte strings utf8.
//
// Never program.account.X.all(): that path can inject the SOURCE size and return
// [] on devnet with HTTP 200 (sentinel-solana docs/14 divergence 2).
import { PublicKey } from '@solana/web3.js';
import { BN, utils } from '@coral-xyz/anchor';
import { rpcCall } from './rpc';
import { coder, pda, fetchConfig, PROGRAM_ID, type KeyLike } from './program';
import { DEPLOYED_SIZES, discriminator, OFFSETS, protocolNames, type AccountName } from './idl';

const bs58 = utils.bytes.bs58;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function norm(v: unknown): Json {
  if (v === null || v === undefined) return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (BN.isBN(v)) return (v as BN).toString(10);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (Array.isArray(v)) return v.every((x) => typeof x === 'number') ? Buffer.from(v as number[]).toString('hex') : v.map(norm);
  if (typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = norm(x);
    return out;
  }
  return v;
}

function decodeTyped(name: AccountName, data: Buffer): Json {
  const raw = coder().decode(name, data);
  const out = norm(raw);
  if (name === 'provider' || name === 'node') {
    out.uri = Buffer.from(raw.uri.slice(0, raw.uriLen)).toString('utf8');
    delete out.uriLen;
    if (name === 'node') {
      out.country = Buffer.from(raw.country).toString('utf8').replace(/\0/g, '');
      out.protocolNames = protocolNames(raw.protocols);
    }
  }
  delete out.reserved;
  return out;
}

export function decodeAccount(name: AccountName, data: Buffer): Json {
  return decodeTyped(name, data);
}

export class WrongAccountTypeError extends Error {
  code = 'wrong-account-type';
}

export async function fetchOne(name: AccountName, address: KeyLike): Promise<Json | null> {
  const addr = new PublicKey(address);
  const info = await rpcCall((c) => c.getAccountInfo(addr, 'confirmed'), { label: `${name}:${addr.toBase58().slice(0, 6)}` });
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) return null;
  if (info.data.length !== DEPLOYED_SIZES[name] || !Buffer.from(info.data.subarray(0, 8)).equals(discriminator(name))) {
    throw new WrongAccountTypeError(`${addr.toBase58()} is not a ${name} account`);
  }
  return { address: addr.toBase58(), ...decodeTyped(name, info.data) };
}

export async function fetchMany(name: AccountName, memcmps: Array<{ offset: number; pubkey: KeyLike }> = []): Promise<Json[]> {
  const filters = [
    { dataSize: DEPLOYED_SIZES[name] },
    { memcmp: { offset: 0, bytes: bs58.encode(discriminator(name)) } },
    ...memcmps.map(({ offset, pubkey }) => ({ memcmp: { offset, bytes: new PublicKey(pubkey).toBase58() } })),
  ];
  const rows = await rpcCall(
    (c) => c.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters }),
    { label: `${name}:list`, timeoutMs: 30_000 },
  );
  const out: Json[] = [];
  for (const r of rows) {
    try {
      out.push({ address: r.pubkey.toBase58(), ...decodeTyped(name, r.account.data as Buffer) });
    } catch (err) {
      console.warn(`[accounts] skipping undecodable ${name} ${r.pubkey.toBase58()}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ─── typed readers ───
export const getConfig = fetchConfig;

export const allNodes = (): Promise<Json[]> => fetchMany('node');
export const nodeByPda = (addr: KeyLike): Promise<Json | null> => fetchOne('node', addr);

export const allPlans = (): Promise<Json[]> => fetchMany('plan');
export const planByPda = (addr: KeyLike): Promise<Json | null> => fetchOne('plan', addr);
export const allProviders = (): Promise<Json[]> => fetchMany('provider');
export const providerByPda = (addr: KeyLike): Promise<Json | null> => fetchOne('provider', addr);
export const leasesByProvider = (provider: KeyLike): Promise<Json[]> => fetchMany('lease', [{ offset: OFFSETS.lease.provider, pubkey: provider }]);

export const subscriptionsByOwner = (owner: KeyLike): Promise<Json[]> => fetchMany('subscription', [{ offset: OFFSETS.subscription.owner, pubkey: owner }]);
export const subscriptionByPda = (addr: KeyLike): Promise<Json | null> => fetchOne('subscription', addr);

export const channelsByOwner = (owner: KeyLike): Promise<Json[]> => fetchMany('channel', [{ offset: OFFSETS.channel.owner, pubkey: owner }]);
export const channelByPda = (addr: KeyLike): Promise<Json | null> => fetchOne('channel', addr);

export const userByOwner = (owner: KeyLike): Promise<Json | null> => fetchOne('user', pda.user(owner));
/** The owner's all-target grant to `grantee` (the device key), or null. */
export const grantOf = (owner: KeyLike, grantee: KeyLike): Promise<Json | null> => fetchOne('grant', pda.grant(owner, grantee));

// Grant lookups are cached 10 min: every node probe (every 5 min, each refresh, Node test, up to 30
// at once) asked for the same 1-2 grant accounts per operator-signed node. Grants rarely change;
// expiry is still checked against "now" on each call. A failed lookup is not cached.
const GRANT_TTL_MS = 10 * 60_000;
const grantCache = new Map<string, { at: number; grant: Promise<Json | null> }>();
export function cachedGrant(address: PublicKey, nowMs = Date.now(), fetch = (a: PublicKey) => fetchOne('grant', a)): Promise<Json | null> {
  const key = address.toBase58();
  const hit = grantCache.get(key);
  if (hit && nowMs - hit.at < GRANT_TTL_MS) return hit.grant;
  // The promise is shared, so 30 probes at once make one call, not 30.
  const grant = fetch(address);
  grantCache.set(key, { at: nowMs, grant });
  grant.catch(() => { if (grantCache.get(key)?.grant === grant) grantCache.delete(key); });
  return grant;
}
export const clearGrantCache = (): void => grantCache.clear();

/**
 * sentinel-go-sdk auth.Authorize (auth.go): the owner itself, or a grant [owner, signer, subject]
 * or [owner, signer, all] whose permissions hold every bit asked for and which has not expired
 * (expiresAt 0 = never). An RPC failure throws: the caller treats the signer as unverified.
 */
export async function signerAuthorized(
  owner: KeyLike, signer: KeyLike, permission: number, subject?: KeyLike,
  { now = Math.floor(Date.now() / 1000), fetchGrant = cachedGrant }: { now?: number; fetchGrant?: (address: PublicKey) => Promise<Json | null> } = {},
): Promise<boolean> {
  const o = new PublicKey(owner.toString());
  const s = new PublicKey(signer.toString());
  if (o.equals(s)) return true;
  const targets = subject ? [new PublicKey(subject.toString()), PublicKey.default] : [PublicKey.default];
  for (const t of targets) {
    const g = await fetchGrant(pda.grant(o, s, t));
    if (!g) continue;
    const exp = Number(g.expiresAt ?? 0);
    const bits = BigInt(String(g.permissions ?? 0));
    if ((bits & BigInt(permission)) === BigInt(permission) && (exp === 0 || exp > now)) return true;
  }
  return false;
}
