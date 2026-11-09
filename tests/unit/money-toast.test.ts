// ─── Q0310: a money action that worked says so ───
// TAN (Android RC3): Top up / Settle closed the dialog with no word; the person could not tell it worked.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendToast, settleToast, topUpToast, withdrawToast } from '../../src/shared/money-toast';

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('money action toasts (Q0310)', () => {
  it('names the amount or what was sent', () => {
    expect(topUpToast('0.01')).toBe('Topped up 0.01 tDVPN.');
    expect(withdrawToast('1.5')).toBe('Moved 1.5 tDVPN of refunds to your wallet.');
    expect(settleToast(['a', 'b', 'c'])).toMatch(/^Settlement sent: 3 transactions\./);
    expect(settleToast(['a'])).toMatch(/^Settlement sent: 1 transaction\./);
    expect(settleToast([])).toMatch(/^Nothing to settle right now/);
    expect(settleToast(undefined)).toMatch(/^Nothing to settle right now/);
    expect(sendToast('2', 'sol', 'AbCdEfGhIjKlMnOp')).toBe('Sent 2 SOL to AbCd…MnOp.');
  });

  it('every money dialog toasts after its call returns', () => {
    const activity = read('src/renderer/src/screens/Activity.tsx');
    expect(activity).toMatch(/SETTLE_RUN, \{ confirmed: true \}\); useApp\.getState\(\)\.toast\('success', settleToast\(sigs\)\)/);
    expect(activity).toMatch(/CHANNEL_FUND, [^)]*\); useApp\.getState\(\)\.toast\('success', topUpToast\(fund\.amount\)\)/);
    const wallet = read('src/renderer/src/screens/Wallet.tsx');
    expect(wallet).toMatch(/IPC\.WITHDRAW, \{ confirmed: true \}\); useApp\.getState\(\)\.toast\('success', withdrawToast\(amount\)\)/);
    expect(wallet).toMatch(/SETTLE_RUN, \{ device: otherAddr, confirmed: true \}\); useApp\.getState\(\)\.toast\('success', settleToast\(sigs\)\)/);
    expect(wallet).toMatch(/IPC\.SEND, .*?confirmed: true \}\); useApp\.getState\(\)\.toast\('success', sendToast\(/);
  });
});
