// ─── Q0319: Plans shows a subscription made outside the app without waiting for the 600 s poll ───
// A subscription bought in the CLI or on another device appeared on Plans only at the next
// "subscriptions" poll (600 s) and the screen had no refresh. Plans now re-reads them when it opens
// and on its Refresh control (data-plans-refresh), through SUBSCRIPTIONS_REFRESH → refreshSubscriptions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC, TIERS } from '../../src/shared/ipc';

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('Plans refreshes subscriptions (Q0319)', () => {
  it('a read-only channel that re-reads the chain', () => {
    expect(IPC.SUBSCRIPTIONS_REFRESH).toBe('subscriptions:refresh');
    expect(TIERS[IPC.SUBSCRIPTIONS_REFRESH]).toBe('readonly');
    expect(read('src/main/ipc.ts')).toMatch(/\[IPC\.SUBSCRIPTIONS_REFRESH\]: \(\) => refreshSubscriptions\(\)/);
  });

  it('Plans re-reads them when it opens', () => {
    const src = read('src/renderer/src/screens/Plans.tsx');
    expect(src).toMatch(/call\(window\.api\.IPC\.SUBSCRIPTIONS_REFRESH/);
    expect(src).toMatch(/useEffect\(\(\) => \{ void refreshSubs\(true\); \}, \[\]\)/);
    // the Refresh button is not quiet: a failed refresh reaches the user as a toast
    expect(src).toMatch(/const refreshSubs = async \(quiet = false\)/);
    expect(src).toMatch(/SUBSCRIPTIONS_REFRESH, undefined, \{ quiet \}\)/);
  });

  it('Plans has a Refresh control that does the same', () => {
    expect(read('src/renderer/src/screens/Plans.tsx')).toMatch(/<button[^>]*data-plans-refresh[^>]*onClick=\{\(\) => void refreshSubs\(\)\}/);
  });
});
