// A sent tx whose status reads are rate-limited must still be reported as landed (test-host,
// 2026-10-21: device setup landed, two 429 reads, user told "failed").
import { afterEach, describe, expect, it, vi } from 'vitest';

const rpcCall = vi.fn();
vi.mock('../../src/core/chain/rpc', async (orig) => {
  const real = await orig<typeof import('../../src/core/chain/rpc')>();
  return { ...real, rpcCall: (...a: unknown[]) => rpcCall(...a) };
});

import { confirmSignature } from '../../src/core/chain/tx';
import { RPC_UNAVAILABLE, isTransportError } from '../../src/core/chain/rpc';

const exhausted = (): Error => {
  const e = new Error('x:status: all RPC endpoints failed:\n  https://api.devnet.solana.com/: 429 Too Many Requests');
  e.name = RPC_UNAVAILABLE;
  return e;
};

describe('confirmSignature', () => {
  afterEach(() => { vi.useRealTimers(); rpcCall.mockReset(); });

  it('pool exhaustion is a transport error (its first line has no 429)', () => {
    expect(isTransportError(exhausted())).toBe(true);
  });

  it('keeps polling through rate-limited reads and returns the landed tx', async () => {
    vi.useFakeTimers();
    rpcCall
      .mockRejectedValueOnce(exhausted())
      .mockRejectedValueOnce(exhausted())
      .mockResolvedValue({ value: [{ confirmationStatus: 'confirmed', err: null, slot: 7 }] });
    const p = confirmSignature('sig', 10_000, 'device_setup');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ ok: true, signature: 'sig', slot: 7 });
  });

  it('a program error from the chain still fails at once', async () => {
    rpcCall.mockResolvedValue({ value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6046 }] }, slot: 7 }] });
    await expect(confirmSignature('sig', 10_000, 'x')).rejects.toThrow(/PermissionNotGranted/);
  });

  it('times out with "sent, may still land", not "failed"', async () => {
    vi.useFakeTimers();
    rpcCall.mockImplementation(async () => { throw exhausted(); });
    const p = confirmSignature('sig', 10_000, 'device_setup');
    const assertion = expect(p).rejects.toThrow(/sent but not confirmed.*may still land/);
    await vi.advanceTimersByTimeAsync(70_000);
    await assertion;
  });
});
