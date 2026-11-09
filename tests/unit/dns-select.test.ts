// ─── W-X64-UI-DNS-CUSTOM: the Settings DNS select can enter and stay in Custom ───
import { describe, expect, it } from 'vitest';
import { DNS_CUSTOM, DNS_PRESETS, dnsPresetKey, dnsSelectChange, dnsSelectValue } from '../../src/core/daemon/dns-presets';

const CF = DNS_PRESETS.cloudflare.servers;

describe('DNS select', () => {
  it('shows the matching preset when not in custom mode', () => {
    expect(dnsSelectValue(CF, false)).toBe('cloudflare');
    expect(dnsPresetKey(['5.5.5.5'])).toBeNull();
    expect(dnsSelectValue(['5.5.5.5'], false)).toBe(DNS_CUSTOM);
    expect(dnsSelectValue(undefined, false)).toBe(DNS_CUSTOM);
  });

  it('picking Custom while a preset is active enters custom mode and keeps the servers to edit', () => {
    const next = dnsSelectChange(DNS_CUSTOM, CF);
    expect(next).toEqual({ customMode: true, dnsServers: CF });
    expect(next.dnsServers).not.toBe(CF); // a copy, never the preset array itself
    // the bug: the select snapped back to the preset because the servers still matched it
    expect(dnsSelectValue(next.dnsServers, next.customMode)).toBe(DNS_CUSTOM);
  });

  it('custom mode sticks while the typed list happens to equal a preset', () => {
    expect(dnsSelectValue(['1.1.1.1', '1.0.0.1'], true)).toBe(DNS_CUSTOM);
  });

  it('picking a preset leaves custom mode and copies that preset', () => {
    const next = dnsSelectChange('quad9', ['5.5.5.5']);
    expect(next).toEqual({ customMode: false, dnsServers: DNS_PRESETS.quad9.servers });
    expect(next.dnsServers).not.toBe(DNS_PRESETS.quad9.servers);
    expect(dnsSelectValue(next.dnsServers, next.customMode)).toBe('quad9');
  });

  it('there is no preset named custom (Custom is UI-only)', () => {
    expect(DNS_PRESETS[DNS_CUSTOM]).toBeUndefined();
  });
});
