// ─── Q0267: the Handshake preset keeps one non-HNS fallback ───
import { describe, expect, it } from 'vitest';
import { DNS_PRESETS, dnsLabel, upgradeDnsServers } from '../../src/core/daemon/dns-presets';

const OLD_HANDSHAKE = ['103.196.38.38', '103.196.38.39'];

describe('Handshake DNS preset (Q0267)', () => {
  it('lists both HNSDNS servers first, then 1.1.1.1', () => {
    expect(DNS_PRESETS.handshake.servers).toEqual(['103.196.38.38', '103.196.38.39', '1.1.1.1']);
  });

  it('a list saved before the change becomes the current preset and keeps its name', () => {
    expect(upgradeDnsServers(OLD_HANDSHAKE)).toEqual(DNS_PRESETS.handshake.servers);
    expect(upgradeDnsServers(OLD_HANDSHAKE)).not.toBe(DNS_PRESETS.handshake.servers); // a copy
    expect(dnsLabel(upgradeDnsServers(OLD_HANDSHAKE))).toBe(DNS_PRESETS.handshake.label);
  });

  it('every other list is left alone (custom order, other presets, empty)', () => {
    for (const l of [['103.196.38.39', '103.196.38.38'], ['103.196.38.38'], DNS_PRESETS.cloudflare.servers, ['5.5.5.5'], undefined]) {
      expect(upgradeDnsServers(l)).toBe(l);
    }
  });

  it('every preset fits dvpnd and the settings check (1 to 4 servers)', () => {
    for (const p of Object.values(DNS_PRESETS)) expect(p.servers.length).toBeGreaterThanOrEqual(1);
    for (const p of Object.values(DNS_PRESETS)) expect(p.servers.length).toBeLessThanOrEqual(4);
  });
});

// Wiring (lesson of Q0271: a helper test passes even when the caller never uses it).
import { parseSettings } from '../../src/core/daemon/config';

describe('parseSettings upgrades a saved Handshake list (Q0267)', () => {
  const client = (list: string[]): string => `[network]\ndns_servers = [${list.map((s) => `"${s}"`).join(', ')}]\n`;
  it('an install saved with the 2-server Handshake list reads as the current preset', () => {
    expect(parseSettings('', client(OLD_HANDSHAKE)).dnsServers).toEqual(DNS_PRESETS.handshake.servers);
  });
  it('a custom list is read as written', () => {
    expect(parseSettings('', client(['9.9.9.9', '1.1.1.1'])).dnsServers).toEqual(['9.9.9.9', '1.1.1.1']);
  });
});
