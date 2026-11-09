import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '.', isPackaged: false }, ipcMain: { handle: vi.fn() } }));

describe('prepay used by the deposit reuse check', () => {
  it('reads a configured 0 as a node minimum block (a tenth of the default), never as "nothing needed"', async () => {
    const { prepayFor } = await import('../../src/main/services/connect-checks');
    const node = { pricePerGb: '1000', pricePerHour: '1000' };
    expect(prepayFor(node, 'per_hour', '0', '0')).toBe(100n);
    expect(prepayFor(node, 'per_gb', '0', '0')).toBe(100n);
    expect(prepayFor(node, 'per_hour', undefined, null)).toBe(100n);
    expect(prepayFor(node, 'per_hour', '0', '1800')).toBe(250n); // Q0338: capped at 900 s
    expect(prepayFor(node, 'per_gb', '2000000000', '0')).toBe(269n); // Q0338: capped at 256 MiB
  });
  it('a 1 GB per-GB deposit with the first 100 MB block taken is still reusable (ui-win-2 adopt)', async () => {
    const { prepayFor } = await import('../../src/main/services/connect-checks');
    // devnet node 8sV25: 0.001 tDVPN/GB (1000 base units, 6 decimals), deposit 0.001, used 0.0001
    const left = 1000n - 100n;
    expect(left >= prepayFor({ pricePerGb: '1000', pricePerHour: '1000' }, 'per_gb', '0', '0')).toBe(true);
    expect(0n >= prepayFor({ pricePerGb: '1000', pricePerHour: '1000' }, 'per_gb', '0', '0')).toBe(false);
  });
  it('a spent stream deposit (0 left) is never good enough', async () => {
    const { prepayFor } = await import('../../src/main/services/connect-checks');
    const { streamLeft } = await import('../../src/core/settlement/settlement');
    const now = 1_792_670_000;
    const spent = { escrow: '1000', ratePerHour: '1000', streamBase: '0', streamStartedAt: String(now - 8634) };
    expect(streamLeft(spent, now)).toBe(0n);
    expect(streamLeft(spent, now) >= prepayFor({ pricePerGb: '0', pricePerHour: '0' }, 'per_hour', '0', '0')).toBe(false);
  });
});
