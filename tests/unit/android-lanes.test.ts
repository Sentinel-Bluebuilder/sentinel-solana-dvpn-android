import { describe, expect, it } from 'vitest';
import { androidLanes, type AndroidSplit } from '../../src/core/split/android-lanes';

const base = { allowLan: false, live: true, vpnIp: '203.0.113.1', homeIp: '203.0.113.1', appName: (p: string) => (p === 'com.bank' ? 'Bank' : p) };
const split = (s: Partial<AndroidSplit>): AndroidSplit => ({ mode: 'all', packages: [], routeMode: 'all', routes: [], ...s });

describe('androidLanes', () => {
  it('all apps: everything but this app through the VPN, both exits shown', () => {
    const l = androidLanes({ ...base, split: split({}) });
    expect(l.vpn.map((x) => x.label)).toEqual(['Every app']);
    expect(l.direct.map((x) => x.label)).toEqual(['This app, to pay nodes']);
    expect([l.vpnExit, l.directExit]).toEqual(['203.0.113.1', '203.0.113.1']);
  });
  it('exclude: the chosen app is on the normal connection, with its name', () => {
    const l = androidLanes({ ...base, split: split({ mode: 'exclude', packages: ['com.bank'] }) });
    expect(l.vpn[0].label).toBe('Every other app');
    expect(l.direct[0]).toEqual({ label: 'Bank', pkg: 'com.bank' });
  });
  it('include + addresses + allow LAN', () => {
    const l = androidLanes({ ...base, allowLan: true, split: split({ mode: 'include', packages: ['com.bank'], routeMode: 'include', routes: ['1.1.1.1/32'] }) });
    expect(l.vpn.map((x) => x.label)).toEqual(['Bank', 'only to 1 chosen address']);
    expect(l.direct.map((x) => x.label)).toEqual(['Every other app', 'Everything else those apps send', 'Your local network (Allow local network)', 'This app, to pay nodes']);
  });
  it('not connected: no VPN exit claimed', () => {
    expect(androidLanes({ ...base, live: false, split: split({ routeMode: 'exclude', routes: ['10.0.0.0/8', '1.1.1.1/32'] }) }).vpnExit).toBeNull();
    expect(androidLanes({ ...base, split: split({ routeMode: 'exclude', routes: ['10.0.0.0/8', '1.1.1.1/32'] }) }).direct[0].label).toBe('2 address ranges');
  });
});
