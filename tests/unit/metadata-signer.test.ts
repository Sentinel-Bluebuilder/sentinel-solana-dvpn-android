// ─── Who may sign node / provider metadata (sentinel-go-sdk auth.Authorize, cf4c372) ───
// The owner, or an operator holding a live grant [owner, operator, subject|all] with the
// permission bit. Nodes signed through a grant were rejected as "not signed by the node owner".
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { signerAuthorized, cachedGrant, clearGrantCache } from '../../src/core/chain/accounts';
import { pda } from '../../src/core/chain/program';
import { PERM_SIGN_NODE_METADATA, PERM_SIGN_PROVIDER_METADATA } from '../../src/core/chain/idl';

const owner = Keypair.generate().publicKey;
const operator = Keypair.generate().publicKey;
const node = Keypair.generate().publicKey;
const NOW = 1_800_000_000;

/** A grant store keyed by PDA; records which PDAs were asked for. */
function store(grants: Array<{ target: PublicKey; permissions: number; expiresAt?: number }>) {
  const asked: string[] = [];
  const byPda = new Map(grants.map((g) => [pda.grant(owner, operator, g.target).toBase58(), { permissions: String(g.permissions), expiresAt: String(g.expiresAt ?? 0) }]));
  return { asked, fetchGrant: async (a: PublicKey) => { asked.push(a.toBase58()); return byPda.get(a.toBase58()) ?? null; } };
}

describe('signerAuthorized', () => {
  it('the owner signing needs no grant and no lookup', async () => {
    const s = store([]);
    expect(await signerAuthorized(owner, owner, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: s.fetchGrant })).toBe(true);
    expect(s.asked).toHaveLength(0);
  });

  it('an operator with a grant for this node and the bit is allowed', async () => {
    const s = store([{ target: node, permissions: PERM_SIGN_NODE_METADATA | 0x4 }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: s.fetchGrant })).toBe(true);
    expect(s.asked[0]).toBe(pda.grant(owner, operator, node).toBase58());
  });

  it('a grant for all of the owner\'s accounts (default target) also counts', async () => {
    const s = store([{ target: PublicKey.default, permissions: PERM_SIGN_NODE_METADATA }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: s.fetchGrant })).toBe(true);
    expect(s.asked).toEqual([pda.grant(owner, operator, node).toBase58(), pda.grant(owner, operator, PublicKey.default).toBase58()]);
  });

  it('an expired grant is refused; one that expires later is accepted', async () => {
    const past = store([{ target: node, permissions: PERM_SIGN_NODE_METADATA, expiresAt: NOW - 1 }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: past.fetchGrant })).toBe(false);
    const atNow = store([{ target: node, permissions: PERM_SIGN_NODE_METADATA, expiresAt: NOW }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: atNow.fetchGrant })).toBe(false);
    const later = store([{ target: node, permissions: PERM_SIGN_NODE_METADATA, expiresAt: NOW + 60 }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: later.fetchGrant })).toBe(true);
  });

  it('a grant without the permission bit is refused (node bit is not the provider bit)', async () => {
    const s = store([{ target: node, permissions: 0x4 | PERM_SIGN_PROVIDER_METADATA }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: s.fetchGrant })).toBe(false);
    const p = store([{ target: node, permissions: PERM_SIGN_NODE_METADATA }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_PROVIDER_METADATA, node, { now: NOW, fetchGrant: p.fetchGrant })).toBe(false);
  });

  it('a grant for a different node does not count', async () => {
    const s = store([{ target: Keypair.generate().publicKey, permissions: PERM_SIGN_NODE_METADATA }]);
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: s.fetchGrant })).toBe(false);
  });

  it('no grant at all is refused', async () => {
    expect(await signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: store([]).fetchGrant })).toBe(false);
  });

  it('an RPC failure throws, so the caller marks the node unverified instead of guessing', async () => {
    await expect(signerAuthorized(owner, operator, PERM_SIGN_NODE_METADATA, node, { now: NOW, fetchGrant: async () => { throw new Error('rpc 429'); } })).rejects.toThrow('rpc 429');
  });

  it('the permission bits match the program (PermUpdateNode 0x2, PermUpdateProvider 0x100)', () => {
    expect(PERM_SIGN_NODE_METADATA).toBe(0x2);
    expect(PERM_SIGN_PROVIDER_METADATA).toBe(0x100);
  });

  it('grant lookups are cached 10 min and shared by concurrent probes; failures are not cached', async () => {
    clearGrantCache();
    let calls = 0;
    const fetch = async () => { calls++; return { permissions: '2', expiresAt: '0' }; };
    const a = pda.grant(owner, operator, node);
    await Promise.all(Array.from({ length: 30 }, () => cachedGrant(a, 0, fetch)));
    expect(calls).toBe(1);
    await cachedGrant(a, 9 * 60_000, fetch);
    expect(calls).toBe(1);
    await cachedGrant(a, 10 * 60_000, fetch);
    expect(calls).toBe(2);
    clearGrantCache();
    const b = pda.grant(owner, operator, PublicKey.default);
    await expect(cachedGrant(b, 0, async () => { throw new Error('rpc 429'); })).rejects.toThrow('rpc 429');
    await cachedGrant(b, 1, fetch);
    expect(calls).toBe(3);
  });
});
