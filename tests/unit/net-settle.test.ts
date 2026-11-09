// ─── waitForDirectPath: switch waits for the network after the old tunnel stops ───
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcCall = vi.fn();
vi.mock('../../src/core/chain/rpc', () => ({ rpcCall: (...a: unknown[]) => rpcCall(...a) }));
vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { waitForDirectPath, waitForDns } = await import('../../src/main/services/net-settle');
const noSleep = async (): Promise<void> => undefined;

describe('waitForDirectPath', () => {
  beforeEach(() => { rpcCall.mockReset(); });

  it('returns at once when the RPC answers', async () => {
    rpcCall.mockResolvedValue(1);
    expect(await waitForDirectPath(5_000, noSleep)).toBe(true);
    expect(rpcCall).toHaveBeenCalledTimes(1);
  });

  it('keeps trying while reads fail with "fetch failed", then succeeds', async () => {
    rpcCall.mockRejectedValueOnce(new Error('fetch failed')).mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(1);
    expect(await waitForDirectPath(5_000, noSleep)).toBe(true);
    expect(rpcCall).toHaveBeenCalledTimes(3);
  });

  it('gives up after the limit and never throws', async () => {
    rpcCall.mockImplementation(async () => { throw new Error('fetch failed'); });
    const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    expect(await waitForDirectPath(40, sleep)).toBe(false);
  });
});

describe('waitForDns', () => {
  it('waits through the first failed lookups after the tunnel comes up', async () => {
    let n = 0;
    const lookup = async (): Promise<void> => { if (++n < 4) throw new Error('getaddrinfo ENOTFOUND api.devnet.solana.com'); };
    expect(await waitForDns('api.devnet.solana.com', 5_000, lookup, noSleep)).toBe(true);
    expect(n).toBe(4);
  });
  it('gives up after the limit and never throws', async () => {
    const lookup = async (): Promise<void> => { throw new Error('ENOTFOUND'); };
    expect(await waitForDns('x', 30, lookup, () => new Promise((r) => setTimeout(r, 5)))).toBe(false);
  });
});
