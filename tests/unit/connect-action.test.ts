// ─── The button under a failed or stopped connect (Home + tray) ───
// the Windows app 2026-10-22: 'cancelled' and 'port-in-use' got their own copy; each needs the right next step.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { connectActionButton } from '../../src/shared/connect-action';
import { connectErrorCopy } from '../../src/core/session/state';

describe('connectActionButton', () => {
  it('a stop retries the same server ("Connect again")', () => {
    const c = connectErrorCopy('failed precondition: stop requested while connecting: opening channel');
    expect(c.code).toBe('cancelled');
    expect(connectActionButton(c.action)).toEqual({ target: 'same-node', label: 'Connect again' });
  });

  it('a busy local port offers Servers, for a server with another protocol', () => {
    const c = connectErrorCopy('starting service: failed to listen TCP on 1080: bind: address already in use');
    expect(c.code).toBe('port-in-use');
    expect(c.message).toMatch(/port 1080/);
    expect(connectActionButton(c.action)).toEqual({ target: 'nodes', label: 'Servers' });
  });

  it('maps the other kinds of advice to the screen that fixes them', () => {
    expect(connectActionButton('Add funds')?.target).toBe('wallet');
    expect(connectActionButton('Top up device')?.target).toBe('wallet');
    expect(connectActionButton('View plans')?.target).toBe('plans');
    expect(connectActionButton('Open settings')?.target).toBe('settings');
    expect(connectActionButton('Open diagnostics')?.target).toBe('diagnostics');
    expect(connectActionButton('Report')?.target).toBe('diagnostics');
    expect(connectActionButton('Pick another server')?.target).toBe('nodes');
    expect(connectActionButton('Try another server or protocol')?.target).toBe('nodes');
    expect(connectActionButton('Reconnect')).toEqual({ target: 'same-node', label: 'Try again' });
    expect(connectActionButton('Increase deposit')?.target).toBe('same-node');
    expect(connectActionButton('restore-network')?.target).toBe('restore');
    // Not "Try again" (the /connect/ rule): a session is already running, end it.
    expect(connectActionButton('Disconnect')).toEqual({ target: 'disconnect', label: 'Disconnect' });
  });

  it('internal codes and no action give no button', () => {
    for (const a of [null, undefined, '', 'adopt', 'unknown']) expect(connectActionButton(a)).toBeNull();
  });

  it('every action the connect copy can give maps to a button', () => {
    const src = fs.readFileSync('src/core/session/state.ts', 'utf8') + fs.readFileSync('src/main/services/connection.ts', 'utf8');
    const actions = [...new Set([...src.matchAll(/action: '([^']+)'/g)].map((m) => m[1]))].filter((a) => !['adopt', 'unknown'].includes(a));
    expect(actions.length).toBeGreaterThan(10);
    for (const a of actions) expect(connectActionButton(a), a).not.toBeNull();
  });
});
