// ─── Stream (per-hour) channel accrual: decides whether an open channel is worth reusing ───
import { describe, expect, it } from 'vitest';
import { streamOwed, streamLeft } from '../../src/core/settlement/settlement';

const RATE = '1000000'; // 1 tDVPN per hour (6 decimals)
const ch = (startedAt: number, escrow = '1000000', base = '0') => ({ escrow, ratePerHour: RATE, streamBase: base, streamStartedAt: String(startedAt) });

describe('streamOwed / streamLeft', () => {
  const t0 = 1_760_000_000;

  it('owes nothing at the start and the whole escrow is left', () => {
    expect(streamOwed(ch(t0), t0)).toBe(0n);
    expect(streamLeft(ch(t0), t0)).toBe(1_000_000n);
  });

  it('accrues by wall-clock time, not traffic', () => {
    expect(streamOwed(ch(t0), t0 + 1800)).toBe(500_000n);
    // the VM case: opened 53 min ago, about 7 min of escrow left, below a 1 h prepay
    expect(streamLeft(ch(t0), t0 + 53 * 60)).toBe(116_667n);
    expect(streamLeft(ch(t0), t0 + 53 * 60) >= 1_000_000n).toBe(false);
  });

  it('adds stream_base (time already paid before a top-up) and caps at escrow', () => {
    expect(streamOwed(ch(t0, '2000000', '250000'), t0 + 3600)).toBe(1_250_000n);
    expect(streamOwed(ch(t0), t0 + 10 * 3600)).toBe(1_000_000n);
    expect(streamLeft(ch(t0), t0 + 10 * 3600)).toBe(0n);
  });

  it('treats a missing start time or a clock before it as no elapsed time', () => {
    expect(streamOwed({ escrow: '5', ratePerHour: RATE }, t0)).toBe(0n);
    expect(streamOwed(ch(t0), t0 - 60)).toBe(0n);
  });
});

describe('channelGone', () => {
  it('a deposit closed elsewhere is skipped, any other error is not', async () => {
    const { channelGone } = await import('../../src/core/settlement/settlement');
    expect(channelGone('AccountNotInitialized (3012): the program expected this account to be already initialized')).toBe(true);
    expect(channelGone('custom program error: (3012)')).toBe(true);
    expect(channelGone('AccountNotFound')).toBe(true);
    // two settles racing on one wallet: the loser meets a channel the winner already moved on (RC triage double-settle)
    expect(channelGone('ChannelNotOpen (6032): channel is not open')).toBe(true);
    expect(channelGone('custom program error: 0x1790')).toBe(false);
    expect(channelGone('InvalidStatus (6004): channel is not open')).toBe(false);
    expect(channelGone('fetch failed')).toBe(false);
    expect(channelGone('insufficient funds for 13012 lamports')).toBe(false);
  });
});

describe('balanceGone', () => {
  it('a refund another settle already withdrew is skipped, any other error is not (Q0242)', async () => {
    const { balanceGone } = await import('../../src/core/settlement/settlement');
    expect(balanceGone('BalanceZero (6023): balance to withdraw is zero')).toBe(true);
    expect(balanceGone('custom program error: (6023)')).toBe(true);
    expect(balanceGone('ChannelNotOpen (6032): channel is not open')).toBe(false);
    expect(balanceGone('insufficient funds for 16023 lamports')).toBe(false);
    expect(balanceGone('fetch failed')).toBe(false);
  });
});
