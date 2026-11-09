// ─── An edit made before the first settings read is kept (splitui deba 2026-10-29) ───
// Split tunnelling page: include + 3 ranges chosen before DAEMON_SETTINGS_GET answered; the read
// then overwrote the draft, Apply said "nothing changed" and the session connected full tunnel.
import { describe, expect, it } from 'vitest';
import { changedKeys, mergeLoaded } from '../../src/core/daemon/draft';

const LOADED = { killSwitch: 'on', allowLan: false, split: { mode: 'off', routes: [] as string[], apps: [] as string[] }, dnsServers: ['1.1.1.1'] };
const EARLY = { split: { mode: 'include', routes: ['104.26.12.205/32', '104.26.13.205/32', '172.67.74.152/32'] } };

describe('settings draft: early edits survive the first read', () => {
  it('changedKeys names what an edit touched', () => {
    expect(changedKeys({}, EARLY)).toEqual(['split']);
    expect(changedKeys(LOADED, { ...LOADED, allowLan: true })).toEqual(['allowLan']);
    expect(changedKeys(LOADED, { ...LOADED })).toEqual([]);
  });
  it('the deba case: include + 3 ranges stay, and differ from the loaded settings (Apply bar shows)', () => {
    const merged = mergeLoaded(LOADED, EARLY, changedKeys({}, EARLY));
    expect(merged.split).toEqual({ mode: 'include', routes: EARLY.split.routes, apps: [] });
    expect(merged.killSwitch).toBe('on');
    expect(merged.dnsServers).toEqual(['1.1.1.1']);
    expect(JSON.stringify(merged)).not.toBe(JSON.stringify(LOADED));
  });
  it('control: the old behaviour (draft = loaded) drops the edit, so nothing would apply', () => {
    const old = { ...LOADED };
    expect(old.split.mode).toBe('off');
    expect(JSON.stringify(old)).toBe(JSON.stringify(LOADED));
  });
  it('one level deep: a mode-only edit keeps the loaded routes', () => {
    const loaded = { ...LOADED, split: { mode: 'exclude', routes: ['10.0.0.0/8'], apps: [] } };
    const draft = { split: { mode: 'include' } };
    expect(mergeLoaded(loaded, draft, ['split']).split).toEqual({ mode: 'include', routes: ['10.0.0.0/8'], apps: [] });
  });
  it('nothing touched: the loaded settings, unchanged', () => {
    expect(mergeLoaded(LOADED, { allowLan: true }, [])).toEqual(LOADED);
  });
});
