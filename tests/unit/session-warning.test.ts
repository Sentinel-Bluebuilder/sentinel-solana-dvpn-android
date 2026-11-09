import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sessionWarningCopy } from '../../src/core/session/state';
import { toLive } from '../../src/main/services/connection';
import type { DaemonSession } from '../../src/core/daemon/client';

// Q0357 (DIR 10-30): a session whose full-size traffic still fails after the clamp stays up, but the
// Connect screen says so (never silent). dvpnd sends Session.warning = "large-packets" (proto 13).

const base: DaemonSession = {
  id: 's1', node: 'n', status: 'active', service: 'wireguard', usage: null, spent: '0', startedAt: null,
  endedAt: null, error: '', channel: '', ticketHash: '', proxyEndpoint: '',
};

describe('session warning', () => {
  it('large-packets has the copy every app shows', () => {
    expect(sessionWarningCopy('large-packets')).toBe(
      'This network drops large packets; some sites may not load. V2Ray or Xray usually works.');
  });

  it('no warning, or a code this app does not know, shows nothing', () => {
    expect(sessionWarningCopy('')).toBeNull();
    expect(sessionWarningCopy(undefined)).toBeNull();
    expect(sessionWarningCopy('something-new')).toBeNull();
  });

  it('the daemon field reaches the live session; an older dvpnd (no field) means none', () => {
    expect(toLive({ ...base, warning: 'large-packets' }).warning).toBe('large-packets');
    expect(toLive(base).warning).toBe('');
  });

  it("the app's proto carries field 13, so the daemon's warning is decoded", () => {
    const proto = readFileSync('resources/daemon.proto', 'utf8');
    expect(proto).toMatch(/message Session \{[^}]*string warning = 13;[^}]*\}/);
  });
});
