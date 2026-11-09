// ─── Instruction builders (owner-signed writes, decision D2) ───
// open/close subscription + withdraw are ported from plans-solana
// lib/solana/program.js. Every builder follows the
// upstream IDL's account list exactly (src/core/chain/idl/dvpn.devnet.json = cb33092e / 26de5240
// sentinel-programs/idl/dvpn.json)
// and is proven on devnet by tests/devnet before the app uses it. cb33 added rent-recipient ARGS
// to every open: the program stores them and refunds the rent there on close; it must be the
// signer or the rent payer (rent.rs). dvpnd channel.go passes the signer.
//
// Signing rules read from the program source (programs/dvpn/src/instructions, auth.rs):
//   Every "owner or grantee" instruction takes an optional `grant` account:
//   null when the owner signs, the [granter=owner, grantee=signer, target] grant otherwise.
//   start_close_channel  owner, or a grantee with PERM_START_CLOSE_CHANNEL
//   close_channel        voucher: anyone after the grace (grant ignored). stream: owner or a
//                        grantee with PERM_CLOSE_CHANNEL, node account required.
//   fund_channels        owner (grant null); channels in remaining_accounts, sorted + unique
//   open_channel by a device pulls tokens through the Config PDA as Token-2022 delegate,
//   so the owner must ApproveChecked(delegate = Config PDA) first; the grant's allowance
//   is the device's cumulative spend cap.
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { createApproveCheckedInstruction, createRevokeInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getProgram, fetchConfig, pda, ata, key, BN, type KeyLike } from './program';
import { MINT, TOKEN_DECIMALS, PERMS_CLIENT } from './idl';

// Anchor's generic method types recurse too deep for tsc on this IDL; builders are typed at their edges.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methods = (): any => getProgram().methods;

const bn = (v: bigint | string | number | BN): BN => (BN.isBN(v) ? (v as BN) : new BN(String(v)));

async function tokenAccounts(): Promise<{ vault: PublicKey; mint: PublicKey; tokenProgram: PublicKey }> {
  const cfg = await fetchConfig();
  return { vault: cfg.vault, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ID };
}

// ─── Token delegate (device spends through the Config PDA) ───

/** Owner approves the Config PDA to move up to `amount` base units from the owner's ATA. */
export function approveDelegate({ owner, amount }: { owner: KeyLike; amount: bigint | string }): TransactionInstruction {
  return createApproveCheckedInstruction(
    ata(owner), MINT, pda.config(), key(owner), BigInt(String(amount)), TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID,
  );
}

export function revokeDelegate({ owner }: { owner: KeyLike }): TransactionInstruction {
  return createRevokeInstruction(ata(owner), key(owner), [], TOKEN_2022_PROGRAM_ID);
}

// ─── Grants (the device's permission to pay for the owner) ───

/** All-target grant, no expiry, with dvpnd's client permissions and a spend cap. */
export async function openGrant({ owner, grantee, allowance, permissions = PERMS_CLIENT, rentPayer = owner }: {
  owner: KeyLike; grantee: KeyLike; allowance: bigint | string; permissions?: number; rentPayer?: KeyLike;
}): Promise<TransactionInstruction> {
  return methods().openGrant(key(grantee), PublicKey.default, bn(permissions), bn(0), bn(String(allowance)), key(rentPayer)).accounts({
    granter: key(owner),
    rentPayer: key(rentPayer),
    grant: pda.grant(owner, grantee),
    systemProgram: SystemProgram.programId,
  }).instruction();
}

/** Change the cap (and, when given, the permissions) of an existing grant. */
export async function updateGrant({ owner, grantee, allowance, permissions }: {
  owner: KeyLike; grantee: KeyLike; allowance: bigint | string; permissions?: number;
}): Promise<TransactionInstruction> {
  return methods().updateGrant(permissions === undefined ? null : bn(permissions), null, bn(String(allowance))).accounts({
    signer: key(owner),
    grant: pda.grant(owner, grantee),
  }).instruction();
}

/** `rentPayer` = the grant's stored rent payer (rent goes back there). */
export async function closeGrant({ owner, grantee, rentPayer }: {
  owner: KeyLike; grantee: KeyLike; rentPayer: KeyLike;
}): Promise<TransactionInstruction> {
  return methods().closeGrant().accounts({
    signer: key(owner),
    grant: pda.grant(owner, grantee),
    rentRecipient: key(rentPayer),
  }).instruction();
}

// ─── Channels (settlement, decision D3) ───

export interface ChannelRef {
  address: KeyLike;
  owner: KeyLike;
  /** Who opened it: the owner, or the device under its grant. */
  opener: KeyLike;
  node: KeyLike;
  rentPayer: KeyLike;
  mode: number;
}

/**
 * Owner-signed channel open (the daemon normally opens channels with the device
 * key; this path serves tests and "pay from my wallet" opens). `node` = decoded Node.
 * Stream terms must quote the node's current hourly price (NodePriceChanged otherwise).
 * Voucher terms name the key that signs vouchers: the owner itself here.
 */
export async function openChannel({ owner, node, channelId, escrow, mode, expectedRate = '0' }: {
  owner: KeyLike; node: { address: KeyLike }; channelId: Buffer; escrow: bigint | string; mode: 0 | 1; expectedRate?: string;
}): Promise<TransactionInstruction> {
  const t = await tokenAccounts();
  const terms = mode === 1 ? { stream: { expectedRatePerHour: bn(expectedRate) } } : { voucher: { voucherSigner: key(owner) } };
  // channel_rent_recipient, user_rent_recipient: the owner signs and pays the rent, so it gets it back.
  return methods().openChannel(Array.from(channelId), bn(String(escrow)), terms, key(owner), key(owner)).accounts({
    signer: key(owner),
    config: pda.config(),
    owner: key(owner),
    grant: null,
    user: pda.user(owner),
    node: key(node.address),
    channel: pda.channel(owner, channelId),
    vault: t.vault,
    mint: t.mint,
    ownerToken: ata(owner),
    tokenProgram: t.tokenProgram,
    rentPayer: key(owner),
    systemProgram: SystemProgram.programId,
  }).instruction();
}

/** Voucher channels only. Owner signs; no grant account. */
export async function startCloseChannel({ owner, channel }: { owner: KeyLike; channel: KeyLike }): Promise<TransactionInstruction> {
  return methods().startCloseChannel().accounts({
    signer: key(owner),
    config: pda.config(),
    channel: key(channel),
    grant: null,
  }).instruction();
}

/** Voucher: after the grace. Stream: immediately (node account settles the accrued amount). */
export async function closeChannel({ signer, ch }: { signer: KeyLike; ch: ChannelRef }): Promise<TransactionInstruction> {
  // The grant is seeded [channel.owner, SIGNER, target]: an owner-signed close passes none, a
  // device's stream close passes its own all-target grant. Voucher closes ignore it.
  const delegated = !key(signer).equals(key(ch.owner));
  return methods().closeChannel().accounts({
    signer: key(signer),
    config: pda.config(),
    channel: key(ch.address),
    user: pda.user(ch.owner),
    grant: delegated && ch.mode === 1 ? pda.grant(ch.owner, signer) : null,
    node: ch.mode === 1 ? key(ch.node) : null,
    rentRecipient: key(ch.rentPayer),
  }).instruction();
}

/** Top up open channels' escrow from User.balance first, then the owner's ATA. */
export async function fundChannels({ owner, channels }: {
  owner: KeyLike; channels: Array<{ address: KeyLike; amount: bigint | string }>;
}): Promise<TransactionInstruction> {
  const t = await tokenAccounts();
  const sorted = [...channels].map((c) => ({ pk: key(c.address), amount: c.amount }))
    .sort((a, b) => Buffer.compare(a.pk.toBuffer(), b.pk.toBuffer()));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].pk.equals(sorted[i - 1].pk)) throw new Error('fund_channels: duplicate channel'); // copy:internal
  return methods().fundChannels(sorted.map((c) => bn(String(c.amount)))).accounts({
    signer: key(owner),
    config: pda.config(),
    owner: key(owner),
    user: pda.user(owner),
    grant: null,
    vault: t.vault,
    mint: t.mint,
    ownerToken: ata(owner),
    tokenProgram: t.tokenProgram,
  }).remainingAccounts(sorted.map((c) => ({ pubkey: c.pk, isSigner: false, isWritable: true }))).instruction();
}

// ─── Subscriptions + refunds (ported, proven by plans-solana) ───

export interface PlanTerms {
  price: string;
  durationSeconds: number;
  dataCapGb: number;
  maxConnections: number;
}

/** Priced plan: the subscriber's ATA pays. Expected terms guard against a price change (PlanTermsChanged). */
export async function openSubscription({ owner, plan, provider, terms }: {
  owner: KeyLike; plan: KeyLike; provider: KeyLike; terms: PlanTerms;
}): Promise<TransactionInstruction> {
  const priced = bn(terms.price).gtn(0);
  const t = priced ? await tokenAccounts() : null;
  return methods().openSubscription(bn(terms.price), Number(terms.durationSeconds), Number(terms.dataCapGb), Number(terms.maxConnections), key(owner)).accounts({
    signer: key(owner),
    rentPayer: key(owner),
    owner: key(owner),
    config: pda.config(),
    plan: key(plan),
    provider: key(provider),
    subscription: pda.subscription(owner, plan),
    grant: null,
    ownerToken: priced ? ata(owner) : null,
    vault: t ? t.vault : null,
    mint: t ? t.mint : null,
    tokenProgram: t ? t.tokenProgram : null,
    systemProgram: SystemProgram.programId,
  }).instruction();
}

/** No refund: closing returns only the account rent (disclosed in the UI). */
export async function closeSubscription({ owner, subscription, rentPayer }: {
  owner: KeyLike; subscription: KeyLike; rentPayer: KeyLike;
}): Promise<TransactionInstruction> {
  return methods().closeSubscription().accounts({
    signer: key(owner),
    subscription: key(subscription),
    rentRecipient: key(rentPayer),
    provider: null,
    grant: null,
  }).instruction();
}

/** Move the whole User.balance (refunds from closed channels) back to the owner's ATA. */
export async function withdrawUserBalance({ owner, userRentPayer }: { owner: KeyLike; userRentPayer: KeyLike }): Promise<TransactionInstruction> {
  const t = await tokenAccounts();
  return methods().withdrawUserBalance().accounts({
    signer: key(owner),
    config: pda.config(),
    owner: key(owner),
    grant: null,
    user: pda.user(owner),
    rentRecipient: key(userRentPayer),
    ownerToken: ata(owner),
    vault: t.vault,
    mint: t.mint,
    tokenProgram: t.tokenProgram,
  }).instruction();
}
