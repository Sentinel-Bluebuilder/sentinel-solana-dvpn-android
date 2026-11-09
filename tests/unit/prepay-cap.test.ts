import { describe, expect, it, vi } from 'vitest';
import { PREPAY_CAP_BYTES, PREPAY_CAP_SECONDS, prepayHint, prepayOverCap } from '../../src/shared/prepay-cap';

vi.mock('electron', () => ({ app: { getPath: () => '.', isPackaged: false }, ipcMain: { handle: vi.fn() } }));

// Q0338: dvpnd caps the prepay at 256 MiB / 15 min. The app must say so, not cap silently.
describe('prepay cap', () => {
  it('names the values dvpnd will cap', () => {
    expect(prepayOverCap('1000000000', '3600')).toEqual(['bytes', 'seconds']);
    expect(prepayOverCap(String(PREPAY_CAP_BYTES), String(PREPAY_CAP_SECONDS))).toEqual([]);
    expect(prepayOverCap('0', '0')).toEqual([]);
    expect(prepayOverCap(undefined, null)).toEqual([]);
    expect(prepayOverCap('100000000', '1800')).toEqual(['seconds']);
  });

  it('the Settings hint warns only when a value is over the cap', () => {
    expect(prepayHint('1000000000', '60')).toContain('larger values are capped to protect you');
    expect(prepayHint('100000000', '60')).not.toContain('capped');
    expect(prepayHint('100000000', '60')).toContain('Max 268 MB and 15 min');
  });

  it('the funds check never counts more than the capped block', async () => {
    const { prepayFor } = await import('../../src/main/services/connect-checks');
    const node = { pricePerGb: '1000000000', pricePerHour: '3600' };
    expect(prepayFor(node, 'per_gb', '2000000000', '0')).toBe(PREPAY_CAP_BYTES);
    expect(prepayFor(node, 'per_hour', '0', '14400')).toBe(PREPAY_CAP_SECONDS);
    expect(prepayFor(node, 'per_gb', '100000000', '0')).toBe(100_000_000n);
  });
});
