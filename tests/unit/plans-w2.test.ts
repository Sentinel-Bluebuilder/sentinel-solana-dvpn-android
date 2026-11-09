import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, safeStorage: {} }));

import { markProviderAnswering, type PlanRecord, type ProviderProbeEntry } from '../../src/core/plans/plans';
import { rosterErrorText } from '../../src/main/services/plans';

const plan = (address: string, provider: string): PlanRecord => ({
  address, provider, price: '1', durationSeconds: 60, dataCapGb: 0, maxConnections: 0, listed: true, providerUri: '', providerListed: true,
});

// ─── W2: plans whose provider does not answer sort last and are marked ───
describe('markProviderAnswering (W2)', () => {
  const plans = [plan('dead1', 'provDead'), plan('live1', 'provLive'), plan('dead2', 'provDead'), plan('live2', 'provLive')];
  const probe = async (p: string) => p === 'provLive';
  it('sorts live plans first, keeps order inside each group, and marks every plan', async () => {
    const out = await markProviderAnswering(plans, probe, new Map());
    expect(out.map((p) => p.address)).toEqual(['live1', 'live2', 'dead1', 'dead2']);
    expect(out.map((p) => p.providerAnswering)).toEqual([true, true, false, false]);
  });
  it('probes each provider once and reuses the cache inside the ttl', async () => {
    const cache = new Map<string, ProviderProbeEntry>();
    const calls: string[] = [];
    const counting = async (p: string) => { calls.push(p); return p === 'provLive'; };
    await markProviderAnswering(plans, counting, cache, 1_000);
    await markProviderAnswering(plans, counting, cache, 30_000);
    expect(calls.sort()).toEqual(['provDead', 'provLive']);
    await markProviderAnswering(plans, counting, cache, 100_000);
    expect(calls).toHaveLength(4);
  });
  it('a probe that throws counts as not answering', async () => {
    const out = await markProviderAnswering([plan('a', 'p')], async () => { throw new Error('boom'); }, new Map());
    expect(out[0].providerAnswering).toBe(false);
  });
});

describe('rosterErrorText (W2)', () => {
  it('maps the raw timeout text to the friendly provider message', () => {
    const t = rosterErrorText('request to 10.0.0.1:18719 timed out after 8000ms');
    expect(t).toContain('provider is not answering');
    expect(t).not.toContain('18719');
  });
  it('keeps other errors readable', () => {
    expect(rosterErrorText('Provider roster unavailable (HTTP 500)\nstack')).toBe("Could not read this plan's server list: Provider roster unavailable (HTTP 500)");
  });
});
