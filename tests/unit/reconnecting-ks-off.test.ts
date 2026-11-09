// Reconnecting vs the kill switch (DIR 11-08, same copy on every app). Kill switch on: dvpnd holds
// traffic until the VPN is back. Kill switch off: dvpnd final3 routes go direct while it reconnects
// (final2 wrongly armed a block, QA live G21 row). The copy says which.
import { describe, it, expect } from 'vitest';
import { RECONNECTING_TITLE, reconnectingView, viewFor } from '../../src/core/session/state';
import { ksState } from '../../src/core/session/ks-view';

describe('Reconnecting copy vs the kill switch', () => {
  it('kill switch off: says traffic goes direct, claims no block, keeps Stop and the daemon detail', () => {
    const v = reconnectingView(viewFor('reconnecting', 'The daemon is retrying the connection.'), true);
    expect(v.title).toBe('Reconnecting… traffic is going direct (kill switch is off)');
    expect(v.title).not.toMatch(/block/i);
    expect(v.canStop).toBe(true);
    expect(v.detail).toBe('The daemon is retrying the connection.');
  });
  it('negative controls: kill switch on keeps the blocked title; other phases are untouched', () => {
    expect(reconnectingView(viewFor('reconnecting'), false).title).toBe(RECONNECTING_TITLE.blocked);
    expect(viewFor('reconnecting').title).toBe('Reconnecting — internet blocked to protect you');
    expect(reconnectingView(viewFor('connected'), true).title).toBe('Protected');
  });
  it('the kill switch page says Blocking only while the kill switch is on', () => {
    expect(ksState({ phase: 'reconnecting', restoreNetwork: false, connected: true, saved: 'off' })).toBe('off');
    expect(ksState({ phase: 'reconnecting', restoreNetwork: false, connected: true, saved: 'on' })).toBe('blocking');
    expect(ksState({ phase: 'reconnecting', restoreNetwork: false, connected: true, saved: 'persist' })).toBe('blocking');
    expect(ksState({ phase: 'idle', restoreNetwork: true, connected: false, saved: 'off' })).toBe('blocking');
  });
});
