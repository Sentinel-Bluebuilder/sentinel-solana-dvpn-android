import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('status names how the session is paid', async () => {
  const { paymentLabel } = await import('../../src/cli/status-cmd');
  const { MODE_STREAM, MODE_VOUCHER } = await import('../../src/core/chain/idl');
  it('plan, per hour, per GB', () => {
    expect(paymentLabel('', null)).toBe('plan');
    expect(paymentLabel('Ch1', MODE_STREAM)).toBe('per hour');
    expect(paymentLabel('Ch1', MODE_VOUCHER)).toBe('per GB');
    expect(paymentLabel('Ch1', null)).toBe('deposit');
  });
});
