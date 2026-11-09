import { describe, expect, it } from 'vitest';
import { connectErrorCopy } from '../../src/core/session/state';
import { connectActionButton } from '../../src/shared/connect-action';

// Q0232: dvpnd started before the network refuses StartSession with "waiting for network".
describe('connectErrorCopy waiting for network', () => {
  it('says the service is waiting for the network, nothing was paid, and retries the same server', () => {
    const c = connectErrorCopy('14 UNAVAILABLE: unavailable: waiting for network: preflight failed: rpc');
    expect(c.code).toBe('waiting-for-network');
    expect(c.message).toMatch(/Waiting for the network/);
    expect(c.message).toMatch(/Nothing was paid/);
    expect(c.retry).toBe(true);
    expect(c.internal).toBe(false);
    expect(connectActionButton(c.action)).toEqual({ target: 'same-node', label: 'Try again' });
  });

  it('leaves other unavailable errors alone', () => {
    expect(connectErrorCopy('14 UNAVAILABLE: unavailable: the kill switch and sessions a previous run left are still being recovered').code).not.toBe('waiting-for-network');
  });
});
