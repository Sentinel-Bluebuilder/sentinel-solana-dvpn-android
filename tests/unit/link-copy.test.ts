import { describe, it, expect } from 'vitest';
import { daemonLinkCopy } from '../../src/core/daemon/link-copy';

describe('daemonLinkCopy (F23: never raw errors)', () => {
  it('maps the gRPC / pipe failures seen in the field to plain copy', () => {
    expect(daemonLinkCopy('GetVersion: No connection established. Last error: connect ECONNREFUSED 127.0.0.1:50071 (2026-10-20T12:41:16.793Z)')).toBe('The VPN service is not running.');
    expect(daemonLinkCopy('14 UNAVAILABLE: Connection dropped')).toBe('The VPN service is not running.');
    expect(daemonLinkCopy('open \\\\.\\pipe\\dvpnd\\client: The system cannot find the file specified.')).toBe('The VPN service is not running.');
    expect(daemonLinkCopy('dial pipe: Access is denied.')).toMatch(/not allowed/);
    expect(daemonLinkCopy('4 DEADLINE_EXCEEDED: Deadline exceeded')).toBe('The VPN service did not answer in time.');
    expect(daemonLinkCopy('something new')).toBe('The VPN service could not be reached.');
  });
});
