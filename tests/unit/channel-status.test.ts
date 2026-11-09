// ─── Deposits show the chain's status, not dvpnd's stale copy ───
// VM sweep 2026-10-21: `channels` listed a deposit as "open" that settlement had already started
// closing, so `channels fund` was offered and then refused.
import { describe, it, expect, vi } from 'vitest';
import type { DaemonChannel } from '../../src/core/daemon/client';

const chain = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock('../../src/core/chain/accounts', () => ({
  channelByPda: vi.fn(),
  channelsByOwner: async () => { if (chain.fail) throw new Error('rpc 429'); return chain.rows; },
}));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => 'Owner1111111111111111111111111111111111111', ownerSigner: vi.fn() }));
vi.mock('../../src/main/logger', () => ({ log: { warn: () => undefined, info: () => undefined } }));
vi.mock('../../src/main/daemon/manager', () => ({ daemon: vi.fn(), daemonInfo: () => ({ reachable: true }) }));
vi.mock('../../src/main/services/connection', () => ({ toLive: (s: unknown) => s }));
vi.mock('../../src/main/services/wallet', () => ({ refreshWallet: vi.fn() }));
vi.mock('../../src/main/services/history', () => ({ listHistory: () => [] }));
const { withChainStatus } = await import('../../src/main/services/activity');

const ch = (address: string, escrow = '1000'): DaemonChannel => ({ address, node: 'N', mode: 0, escrow, cumulative: '0', openedAt: '0', status: 'open' });

describe('withChainStatus', () => {
  it('open / closing / gone on chain', async () => {
    chain.fail = false;
    chain.rows = [{ address: 'A', status: 0, escrow: '1000' }, { address: 'B', status: 1, escrow: '1000' }];
    const out = await withChainStatus([ch('A'), ch('B'), ch('C')]);
    expect(out.map((c) => c.status)).toEqual(['open', 'closing', 'closed']);
  });
  it('a top-up on chain shows the larger escrow', async () => {
    chain.rows = [{ address: 'A', status: 0, escrow: '201000' }];
    expect((await withChainStatus([ch('A', '1000')]))[0].escrow).toBe('201000');
  });
  it('chain unreadable: keeps the service view, never throws', async () => {
    chain.fail = true;
    expect((await withChainStatus([ch('A')]))[0].status).toBe('open');
  });
});
