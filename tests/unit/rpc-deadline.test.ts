import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RPC_URLS, onRpcRetry, rpcCall, rpcUnavailableCopy, setRpcUrls } from '../../src/core/chain/rpc';

// G31 (11-08): with the only endpoint blackholed, a connect's balance read ran ~46 s (12 s timeout, a 4 s and
// a 6 s wait on its own bench, two more 12 s timeouts) and said nothing until it failed.
describe('rpcCall deadline (G31)', () => {
  afterEach(() => {
    setRpcUrls([...DEFAULT_RPC_URLS]);
  });

  const never = (): Promise<never> => new Promise<never>(() => undefined);

  it('a dead endpoint gives up within one deadline, not after every attempt and bench wait', async () => {
    setRpcUrls(['https://rpc-a.example']);
    const t0 = Date.now();
    const err = await rpcCall(never, { label: 'g31:dead', timeoutMs: 300, deadlineMs: 900 }).catch((e: Error) => e);
    const took = Date.now() - t0;
    expect(err).toBeInstanceOf(Error);
    // Without the deadline: 300 + 2000 (bench wait) + 300 + 4000 (bench wait) + 300 ≈ 6.9 s.
    expect(took).toBeLessThan(1500);
    expect(took).toBeGreaterThanOrEqual(300);
  });

  it('says every retry out loud, with the error and the time left', async () => {
    setRpcUrls(['https://rpc-a.example']);
    const seen: Array<{ attempt: number; error: string; leftMs: number }> = [];
    const off = onRpcRetry((e) => seen.push(e));
    await rpcCall(never, { label: 'g31:retries', timeoutMs: 200, deadlineMs: 2500 }).catch(() => undefined);
    off();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].attempt).toBe(1);
    expect(seen[0].error).toMatch(/timed out/);
    expect(seen[0].leftMs).toBeGreaterThan(0);
  });

  it('a read that only ever timed out reads as a slow network, not as no internet', async () => {
    setRpcUrls(['https://rpc-a.example']);
    const err = await rpcCall(never, { label: 'g31:copy', timeoutMs: 200, deadlineMs: 600 }).catch((e: Error) => e);
    const copy = rpcUnavailableCopy(err);
    expect(copy?.message).toMatch(/slow to answer/);
    expect(copy?.message).toMatch(/different RPC endpoint/);
    expect(copy?.message).not.toMatch(/https?:\/\//);
  });

  // G31 live (QA-u22): a blackholed endpoint fails as a bare "fetch failed" after the connect timeout,
  // and that read "check your internet connection".
  it('a "fetch failed" that took most of the attempt reads as slow; a fast one stays unreachable', async () => {
    setRpcUrls(['https://rpc-a.example']);
    const failAfter = (ms: number) => (): Promise<never> => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('fetch failed')), ms));
    const slowErr = await rpcCall(failAfter(350), { label: 'g31:silent', timeoutMs: 400, attempts: 1 }).catch((e: Error) => e);
    expect(rpcUnavailableCopy(slowErr)?.message).toMatch(/slow to answer/);
    const fastErr = await rpcCall(failAfter(5), { label: 'g31:refused', timeoutMs: 400, attempts: 1 }).catch((e: Error) => e);
    expect(rpcUnavailableCopy(fastErr)?.message).toMatch(/could not be reached/);
  });

  // G31 live (Android): two reads share one pending connect and fail in the same millisecond; the read
  // that started later must not read as "check your internet connection".
  it('a read that joined a silent endpoint late still reads as slow', async () => {
    setRpcUrls(['https://rpc-a.example']);
    let fail: (e: Error) => void = () => undefined;
    const shared = new Promise<never>((_, rej) => { fail = rej; });
    const first = rpcCall(() => shared, { label: 'g31:first', timeoutMs: 400, attempts: 1 }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 250));
    const late = rpcCall(() => shared, { label: 'g31:late', timeoutMs: 400, attempts: 1 }).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 100));
    fail(new Error('fetch failed'));
    expect(rpcUnavailableCopy(await first)?.message).toMatch(/slow to answer/);
    expect(rpcUnavailableCopy(await late)?.message).toMatch(/slow to answer/);
    // The endpoint's silence ends with its last open request: a fresh fast failure is unreachable again.
    const fresh = await rpcCall(() => Promise.reject(new Error('fetch failed')), { label: 'g31:fresh', timeoutMs: 400, attempts: 1 }).catch((e: Error) => e);
    expect(rpcUnavailableCopy(fresh)?.message).toMatch(/could not be reached/);
  });

  it('an answer on a retry still comes back', async () => {
    setRpcUrls(['https://rpc-a.example', 'https://rpc-b.example']);
    let n = 0;
    const out = await rpcCall(async () => {
      n++;
      if (n === 1) throw new Error('fetch failed');
      return 42;
    }, { label: 'g31:ok', timeoutMs: 300 });
    expect(out).toBe(42);
  });
});
