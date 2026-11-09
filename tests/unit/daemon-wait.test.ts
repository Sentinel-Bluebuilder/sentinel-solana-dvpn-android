// ─── Connect waits for the service link after a settings change restarts the service ───
import { describe, it, expect } from 'vitest';
import { waitForDaemon } from '../../src/main/services/daemon-wait';

describe('waitForDaemon', () => {
  it('returns at once when the link is up', async () => {
    let calls = 0;
    const d = await waitForDaemon(1000, () => { calls++; return { reachable: true }; }, 5);
    expect(d.reachable).toBe(true);
    expect(calls).toBe(1);
  });
  it('waits until the link comes back', async () => {
    let calls = 0;
    const d = await waitForDaemon(1000, () => ({ reachable: ++calls >= 4 }), 5);
    expect(d.reachable).toBe(true);
    expect(calls).toBe(4);
  });
  it('gives up after maxMs with the last info', async () => {
    const t = Date.now();
    const d = await waitForDaemon(60, () => ({ reachable: false, error: 'down' }), 10);
    expect(d).toEqual({ reachable: false, error: 'down' });
    expect(Date.now() - t).toBeGreaterThanOrEqual(55);
  });
});
