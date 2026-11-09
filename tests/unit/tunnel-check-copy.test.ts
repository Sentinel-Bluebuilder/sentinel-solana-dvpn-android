// Q0357: dvpnd's connect gate ends a session that carries nothing; the app must say why (never the
// generic "tunnel didn't come up" copy, never the TLS-interception copy). Large packets are checked
// after Protected and never fail a connect, so there is no large-packet connect error.
import { describe, expect, it } from 'vitest';
import { connectErrorCopy } from '../../src/core/session/state';

const DEAD =
  'StartSession: unknown: no traffic passes through the tunnel: the node accepted the session but nothing comes back; ' +
  'try another node or protocol (connecting to www.google.com:443 through the tunnel: not ready)';

describe('tunnel check copy (Q0357)', () => {
  it('a dead tunnel is not mistaken for a tunnel that never came up', () => {
    const c = connectErrorCopy(DEAD);
    expect(c.code).toBe('tunnel-dead');
    expect(c.message).toMatch(/no traffic passes/);
    expect(c.retry).toBe(true);
  });

  it('the generic tunnel copy is unchanged', () => {
    expect(connectErrorCopy('StartSession: failed precondition: starting service: handshake did not complete').code).toBe('tunnel-failed');
  });
});
