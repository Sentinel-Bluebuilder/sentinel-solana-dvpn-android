import { describe, expect, it } from 'vitest';
import { compareRuns, runEstimate, runSummary, testBasis, uriIp, verdictFor, type NodeTestRun } from '../../src/core/nodetest/nodetest';

// Prices as the GCP rig nodes list them (0.001 tDVPN per GB and per hour = 1000 base units).
const rig = { pricePerGb: '1000', pricePerHour: '1000' };

describe('node test rules (F20)', () => {
  it('tests per hour when sold (closes at once), else 1 GB, else not at all', () => {
    expect(testBasis(rig)).toBe('per_hour');
    expect(testBasis({ pricePerGb: '1000', pricePerHour: '0' })).toBe('per_gb');
    expect(testBasis({ pricePerGb: '0', pricePerHour: '0' })).toBeNull();
  });

  it('caps a run at the sum of one-unit deposits', () => {
    expect(runEstimate([rig, rig, { pricePerGb: '5000', pricePerHour: '0' }])).toBe(7000n);
  });

  it('reads the exit IP to expect from the node URI, only when it is a literal IP', () => {
    expect(uriIp('https://203.0.113.1:18711')).toBe('203.0.113.1');
    expect(uriIp('https://[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(uriIp('https://node.example.com:443')).toBeNull();
    expect(uriIp('not a uri')).toBeNull();
  });

  it('gives FAIL / SLOW / FAST against the direct baseline', () => {
    expect(verdictFor({ connected: false, exitOk: null, mbps: null, error: 'peer_limit_reached' }, 50).verdict).toBe('FAIL');
    expect(verdictFor({ connected: true, exitOk: false, mbps: 40 }, 50).verdict).toBe('FAIL');
    expect(verdictFor({ connected: true, exitOk: true, mbps: null }, 50).verdict).toBe('FAIL');
    expect(verdictFor({ connected: true, exitOk: true, mbps: 5 }, 50).verdict).toBe('SLOW'); // under 20% of 50
    const fast = verdictFor({ connected: true, exitOk: true, mbps: 25 }, 50);
    expect(fast.verdict).toBe('FAST');
    expect(fast.reason).toContain('50%');
    expect(verdictFor({ connected: true, exitOk: true, mbps: 0.5 }, null).verdict).toBe('SLOW'); // floor without baseline
  });

  it('counts verdicts and reports what changed between runs', () => {
    const r = (node: string, verdict: 'FAST' | 'SLOW' | 'FAIL') => ({ node, verdict }) as NodeTestRun['results'][number];
    const a = { results: [r('A', 'FAST'), r('B', 'FAIL')] } as NodeTestRun;
    const b = { results: [r('A', 'SLOW'), r('B', 'FAIL'), r('C', 'FAST')] } as NodeTestRun;
    expect(runSummary(b)).toEqual({ FAST: 1, SLOW: 1, FAIL: 1, CANCELLED: 0 });
    expect(compareRuns(a, b)).toEqual([{ node: 'A', before: 'FAST', after: 'SLOW' }]);
  });
});
