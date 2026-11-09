import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import { loadIdl, DEPLOYED_SIZES } from '../../src/core/chain/idl';
import { coder, BN } from '../../src/core/chain/program';

// openChannel reads the vault from the Config account; keep it offline.
vi.mock('../../src/core/chain/program', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/chain/program')>();
  return { ...real, fetchConfig: async () => ({ vault: new PublicKey('11111111111111111111111111111113') }) };
});

const b = await import('../../src/core/chain/builders');
const ixCoder = new BorshInstructionCoder(loadIdl());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decode = (data: Buffer): { name: string; data: any } => ixCoder.decode(data) as never;
const owner = Keypair.generate().publicKey;

// cb33092e added rent-recipient args to every open (rent.rs: must be the signer or the rent payer).
// A builder that leaves one out fails on devnet with 102 (the program cannot deserialize the data).
describe('chain builders on the cb33 program', () => {
  it('open_channel names the owner as channel and user rent recipient', async () => {
    const ix = await b.openChannel({ owner, node: { address: Keypair.generate().publicKey }, channelId: Buffer.alloc(32, 7), escrow: '1000', mode: 0 });
    const d = decode(ix.data);
    expect(d.name).toBe('open_channel');
    expect(d.data.channel_rent_recipient.toBase58()).toBe(owner.toBase58());
    expect(d.data.user_rent_recipient.toBase58()).toBe(owner.toBase58());
    expect(ixCoder.encode('open_channel', d.data).equals(ix.data)).toBe(true); // nothing left over
  });

  it('open_grant names the rent payer as grant rent recipient', async () => {
    const payer = Keypair.generate().publicKey;
    const d = decode((await b.openGrant({ owner, grantee: Keypair.generate().publicKey, allowance: '5', rentPayer: payer })).data);
    expect(d.name).toBe('open_grant');
    expect(d.data.grant_rent_recipient.toBase58()).toBe(payer.toBase58());
    expect(d.data.allowance.toString()).toBe('5');
  });

  it('open_subscription names the owner as subscription rent recipient', async () => {
    const ix = await b.openSubscription({ owner, plan: Keypair.generate().publicKey, provider: Keypair.generate().publicKey, terms: { price: '0', durationSeconds: 60, dataCapGb: 1, maxConnections: 1 } });
    const d = decode(ix.data);
    expect(d.name).toBe('open_subscription');
    expect(d.data.subscription_rent_recipient.toBase58()).toBe(owner.toBase58());
  });

  it('decodes rent_recipient (was rent_payer) at the deployed account sizes', async () => {
    const rr = Keypair.generate().publicKey;
    const n = (v: number): BN => new BN(v);
    const grant = { granter: owner, grantee: owner, target: PublicKey.default, permissions: n(1), expiresAt: n(0), allowance: n(0), rentRecipient: rr, createdAt: n(0), bump: 1, reserved: new Array(32).fill(0) };
    const data = await coder().encode('grant', grant);
    expect(data.length).toBe(DEPLOYED_SIZES.grant);
    expect(coder().decode('grant', data).rentRecipient.toBase58()).toBe(rr.toBase58());
  });
});
