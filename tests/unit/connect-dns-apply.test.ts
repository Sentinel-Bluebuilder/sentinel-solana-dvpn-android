// ─── L5: a locked /etc/resolv.conf (container bind-mount) gets its own, fixable copy ───
import { describe, it, expect } from 'vitest';
import { connectErrorCopy } from '../../src/core/session/state';
import { connectActionButton } from '../../src/shared/connect-action';

describe('connectErrorCopy: DNS apply failure (L5)', () => {
  const raw = 'failed precondition: pointing /etc/resolv.conf at the resolved stub: rename /etc/resolv.conf.dvpnd /etc/resolv.conf: device or resource busy';
  it('names DNS and the Settings switch instead of "Something went wrong"', () => {
    const c = connectErrorCopy(raw);
    expect(c.code).toBe('dns-apply');
    expect(c.message).toMatch(/DNS/);
    expect(c.message).toMatch(/Use the VPN's DNS/);
    expect(c.internal).toBe(false);
    expect(connectActionButton(c.action)?.target).toBe('settings');
  });
  it('does not swallow unrelated errors', () => {
    expect(connectErrorCopy('starting service: failed to listen TCP on 1080: bind: address already in use').code).toBe('port-in-use');
    expect(connectErrorCopy('rate_limited').code).toBe('rate_limited');
  });
});
