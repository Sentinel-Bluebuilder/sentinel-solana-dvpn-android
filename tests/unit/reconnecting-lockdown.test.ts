// Android lockdown ("Block connections without VPN") vs the kill-switch-off Reconnecting copy (QA 11-08):
// with lockdown on, the OS blocks traffic while dvpnd reconnects even when the app's kill switch is off,
// so the title must keep the block instead of saying traffic goes direct.
import { describe, it, expect } from 'vitest';
import { RECONNECTING_TITLE, lockdownView, reconnectingView, viewFor } from '../../src/core/session/state';

describe('Reconnecting copy under Android lockdown', () => {
  it('kill switch off + lockdown on: keeps the blocked title, Stop and the detail', () => {
    const off = reconnectingView(viewFor('reconnecting', 'The daemon is retrying the connection.'), true);
    const v = lockdownView(off, true);
    expect(v.title).toBe(RECONNECTING_TITLE.blocked);
    expect(v.title).not.toMatch(/direct/i);
    expect(v.canStop).toBe(true);
    expect(v.detail).toBe('The daemon is retrying the connection.');
  });
  it('negative controls: lockdown off keeps "going direct"; other phases and the on-title are untouched', () => {
    expect(lockdownView(reconnectingView(viewFor('reconnecting'), true), false).title).toBe(RECONNECTING_TITLE.direct);
    expect(lockdownView(viewFor('connected'), true).title).toBe('Protected');
    expect(lockdownView(viewFor('reconnecting'), true).title).toBe(RECONNECTING_TITLE.blocked);
  });
});
