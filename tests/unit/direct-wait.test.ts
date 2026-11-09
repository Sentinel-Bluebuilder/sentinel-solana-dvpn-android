import { describe, expect, it } from 'vitest';
import { waitForDirect } from '../../src/main/system/direct-wait';

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

describe('waitForDirect (W5 d: Disconnect holds until the internet answers)', () => {
  it('returns at once when the first probe answers', async () => {
    const c = clock();
    expect(await waitForDirect({ probe: async () => true, ...c })).toBe(0);
  });

  it('retries until the internet is back and reports how long it took', async () => {
    const c = clock();
    let calls = 0;
    const took = await waitForDirect({ probe: async () => ++calls >= 4, ...c }, 25_000, 1500);
    expect(calls).toBe(4);
    expect(took).toBe(4500);
  });

  it('gives up (null) after the limit instead of hanging Disconnect', async () => {
    const c = clock();
    let calls = 0;
    const took = await waitForDirect({ probe: async () => { calls++; return false; }, ...c }, 6000, 1500);
    expect(took).toBeNull();
    expect(calls).toBeLessThanOrEqual(5);
  });
});
