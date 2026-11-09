// ─── probeNode / providerApi apply the operator rule end to end ───
// The node answers a signed /v1/metadata; the chain says whether the signer may sign for the owner.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { Keypair } from '@solana/web3.js';
import { PROGRAM_ID } from '../../src/core/chain/idl';

const st = vi.hoisted(() => ({
  auth: 'yes' as 'yes' | 'no' | 'throw',
  authCalls: [] as unknown[][],
  payload: {} as Record<string, unknown>,
  signer: '',
  provider: null as null | { owner: string; uri: string },
}));
vi.mock('../../src/core/chain/accounts', () => ({
  allNodes: async () => [], nodeByPda: async () => null, allPlans: async () => [], allProviders: async () => [],
  subscriptionsByOwner: async () => [], providerByPda: async () => st.provider,
  signerAuthorized: async (...args: unknown[]) => {
    st.authCalls.push(args);
    if (st.auth === 'throw') throw new Error('rpc 429');
    return st.auth === 'yes';
  },
}));
vi.mock('../../src/core/nodes/nodeapi', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifySignedMetadata: () => true,
  httpsRequest: async () => ({ status: 200, latencyMs: 5, text: '{}', certSha256: 'ab', json: { payload: st.payload, signer: st.signer } }),
}));
const { probeNode } = await import('../../src/core/nodes/discovery');
const { providerApi } = await import('../../src/core/plans/plans');

const owner = Keypair.generate().publicKey.toBase58();
const operator = Keypair.generate().publicKey.toBase58();
const nodeAddr = Keypair.generate().publicKey.toBase58();
const providerAddr = Keypair.generate().publicKey.toBase58();
let server: net.Server;
let uri = '';

beforeAll(async () => {
  server = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  uri = `https://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { st.auth = 'yes'; st.authCalls = []; });

const nodePayload = (signer: string, operatorField = signer) => {
  st.signer = signer;
  st.payload = { node: nodeAddr, owner, program_id: PROGRAM_ID.toBase58(), operator: operatorField, expires_at: Math.floor(Date.now() / 1000) + 3600 };
};
const probe = () => probeNode({ address: nodeAddr, owner, uri });

describe('probeNode signer', () => {
  it('owner-signed metadata is usable', async () => {
    nodePayload(owner);
    const r = await probe();
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.signerIsOwner).toBe(true);
  });

  it('operator-signed metadata with a valid grant is usable (was refused before)', async () => {
    nodePayload(operator);
    const r = await probe();
    expect(r.error).toBeNull();
    expect(r.ok && r.signerAuthorized).toBe(true);
    expect(r.signerIsOwner).toBe(false);
    // Asked with the node's owner, the signer, the node-metadata bit and the node as subject.
    expect(st.authCalls[0]).toEqual([owner, operator, 0x2, nodeAddr]);
  });

  it('an operator without a valid grant is refused', async () => {
    nodePayload(operator);
    st.auth = 'no';
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/neither the node owner nor an operator it allowed/);
  });

  it('a payload whose operator is not its signer is refused', async () => {
    nodePayload(operator, Keypair.generate().publicKey.toBase58());
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match its on-chain account/);
  });

  it('a failed grant lookup leaves the node unverified, not usable', async () => {
    nodePayload(operator);
    st.auth = 'throw';
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not check the node operator's permission: rpc 429/);
  });
});

describe('providerApi signer', () => {
  const providerPayload = (signer: string, operatorField = signer) => {
    st.provider = { owner, uri };
    st.signer = signer;
    st.payload = { owner, provider: providerAddr, program_id: PROGRAM_ID.toBase58(), operator: operatorField, api: { tls_sha256: 'ab' } };
  };

  it('an operator with the provider grant is accepted, checked with bit 0x100 and the provider as subject', async () => {
    providerPayload(operator);
    await expect(providerApi(providerAddr)).resolves.toMatchObject({ tlsSha256: 'ab' });
    expect(st.authCalls[0]).toEqual([owner, operator, 0x100, providerAddr]);
  });

  it('naming yourself operator is not enough without the grant (was accepted before)', async () => {
    providerPayload(operator);
    st.auth = 'no';
    await expect(providerApi(providerAddr)).rejects.toThrow(/neither the owner nor an operator it allowed/);
  });

  it('operator field that is not the signer is refused', async () => {
    providerPayload(operator, owner);
    await expect(providerApi(providerAddr)).rejects.toThrow(/operator is not the signer/);
  });

  it('a failed grant lookup refuses the provider', async () => {
    providerPayload(operator);
    st.auth = 'throw';
    await expect(providerApi(providerAddr)).rejects.toThrow(/could not be checked \(rpc 429\)/);
  });
});
