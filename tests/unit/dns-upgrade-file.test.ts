import { describe, expect, it } from 'vitest';
import { readToml, upgradeClientDns } from '../../src/core/daemon/config';
import { DNS_PRESETS } from '../../src/core/daemon/dns-presets';

// Q0365: a phone set up before Q0267 kept the 2-server Handshake list in dvpnd's own file (Settings
// showed it upgraded), so the tunnel never had the fallback. The file itself must be upgraded.

const client = (servers: string) => `basis = 'per_gb'\n\n[network]\ndns_backend = 'vpn'\ndns_servers = ${servers}\nkill_switch = 'on'\n`;

describe('saved DNS list in the dvpnd file', () => {
  it('the old 2-server Handshake list becomes the current preset', () => {
    const out = upgradeClientDns(client("['103.196.38.38', '103.196.38.39']"));
    expect(out).not.toBeNull();
    expect(readToml(out!, 'network', 'dns_servers')).toEqual(DNS_PRESETS.handshake.servers);
    expect(readToml(out!, 'network', 'kill_switch')).toBe('on');
    expect(readToml(out!, 'network', 'dns_backend')).toBe('vpn');
  });

  it('a current or custom list is left alone (nothing to write)', () => {
    expect(upgradeClientDns(client("['103.196.38.38', '103.196.38.39', '1.1.1.1']"))).toBeNull();
    expect(upgradeClientDns(client("['9.9.9.9']"))).toBeNull();
    // A preset the user picked, the old Handshake pair in another order, or one of them alone.
    expect(upgradeClientDns(client("['1.1.1.1', '1.0.0.1']"))).toBeNull();
    expect(upgradeClientDns(client("['103.196.38.39', '103.196.38.38']"))).toBeNull();
    expect(upgradeClientDns(client("['103.196.38.38']"))).toBeNull();
    expect(upgradeClientDns(client("['103.196.38.38', '103.196.38.39', '8.8.8.8']"))).toBeNull();
    expect(upgradeClientDns("basis = 'per_gb'\n")).toBeNull();
  });
});
