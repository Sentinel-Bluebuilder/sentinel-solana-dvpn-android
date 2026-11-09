import { describe, it, expect } from 'vitest';
import { adoptedChannelMissing, ADOPT_LAG_DELAYS_MS } from '../../src/core/session/state';

// Rig 2026-10-22: a 429 during a new deposit made the app carry on with a channel dvpnd listed,
// whose open never landed; StartSession said "account not found" and connect showed "Something went wrong".
describe('deposit carried on with after a 429', () => {
  const ch = 'EzAefjsBM3nKcGmrkAhvZDhgMqtdvaEu23SroSH8gNsE';
  const msg = `StartSession: failed precondition: fetching channel ${ch}: account not found: ${ch}`;

  it('is recognised as missing only for that channel', () => {
    expect(adoptedChannelMissing(msg, ch)).toBe(true);
    expect(adoptedChannelMissing(msg, '8GNX1UV699Ntm5sNByVciF4KTbvfEgMFiQG52qh2Afsz')).toBe(false);
    expect(adoptedChannelMissing(msg, null)).toBe(false);
  });

  it('other errors are not "missing"', () => {
    expect(adoptedChannelMissing(`fetching channel ${ch}: rpc error 429`, ch)).toBe(false);
    expect(adoptedChannelMissing('peer_limit_reached', ch)).toBe(false);
  });

  it('waits for RPC lag before paying again (never pays twice at once)', () => {
    expect(ADOPT_LAG_DELAYS_MS.length).toBeGreaterThanOrEqual(2);
    expect(ADOPT_LAG_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
  });
});

describe('pending deposit copy', () => {
  it('names the pending deposit instead of "Something went wrong"', async () => {
    const { connectErrorCopy } = await import('../../src/core/session/state');
    for (const m of [
      'StartSession: failed precondition: channel opening is pending: G5LvpK6dqgHbG6bKbeomcsxs93SwdWA3RmyipBNK65sB',
      'StartSession: failed precondition: fetching channel G5LvpK6dqgHbG6bKbeomcsxs93SwdWA3RmyipBNK65sB: account not found: G5LvpK6dqgHbG6bKbeomcsxs93SwdWA3RmyipBNK65sB',
    ]) {
      const c = connectErrorCopy(m);
      expect(c.code).toBe('deposit-pending');
      expect(c.message).toMatch(/not pay twice/);
    }
  });
});
