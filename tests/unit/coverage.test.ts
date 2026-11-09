// ─── "Protected" only when the exit IP proves it (owner 2026-10-21: "it says connected, IP not changed") ───
import { describe, expect, it } from 'vitest';
import { coverageCopy, coverageOf } from '../../src/core/session/coverage';

const HOME = '49.43.228.6';
const NODE = '203.0.113.1';

describe('coverageOf', () => {
  it('V2Ray/Xray with the system proxy off covers only proxy apps', () => {
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: false, directIp: HOME, homeIp: HOME })).toBe('proxy-only');
  });
  it('V2Ray/Xray with the system proxy on covers browsers once the proxy IP is checked', () => {
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: true, directIp: HOME, proxyIp: NODE, homeIp: HOME })).toBe('proxy-apps');
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: true, directIp: HOME, proxyIp: null, homeIp: HOME })).toBe('unchecked');
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: true, directIp: HOME, proxyIp: HOME, homeIp: HOME })).toBe('leaking');
  });
  it('Xray whole-device mode (TUN): direct exit is the node, so every app is covered', () => {
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: false, directIp: NODE, proxyIp: NODE, homeIp: HOME, nodeIp: NODE })).toBe('device');
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: true, directIp: NODE, proxyIp: NODE, homeIp: null, nodeIp: NODE })).toBe('device');
    // Node exits by another address: direct == proxy exit and not the user's own IP.
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: false, directIp: '1.2.3.4', proxyIp: '1.2.3.4', homeIp: HOME, nodeIp: NODE })).toBe('device');
    // Direct still home: not device, whatever the proxy says.
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: false, directIp: HOME, proxyIp: NODE, homeIp: HOME, nodeIp: NODE })).toBe('proxy-only');
  });
  it('full tunnel with the node IP is the whole device', () => {
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: NODE, homeIp: HOME })).toBe('device');
  });
  it('full tunnel still showing the own IP is leaking', () => {
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: HOME, homeIp: HOME })).toBe('leaking');
  });
  it('full tunnel not measured yet is unchecked, never protected', () => {
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: null, homeIp: HOME })).toBe('unchecked');
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: NODE, homeIp: null })).toBe('unchecked');
  });
});

describe('coverageCopy', () => {
  it('says Protected only for the whole device', () => {
    for (const c of ['proxy-apps', 'proxy-only', 'leaking', 'unchecked'] as const) expect(coverageCopy(c).title).not.toBe('Protected');
    expect(coverageCopy('device').title).toBe('Protected');
  });
  it('never claims protection when apps keep the own IP', () => {
    expect(coverageCopy('proxy-only').ok).toBe(false);
    expect(coverageCopy('leaking').ok).toBe(false);
    expect(coverageCopy('unchecked').ok).toBe(false);
    expect(coverageCopy('leaking', { homeIp: HOME }).detail).toContain(HOME);
  });
  it('says what sites see', () => {
    expect(coverageCopy('device', { vpnIp: NODE }).detail).toContain(NODE);
  });
  it('IP checks off: cannot confirm', () => {
    expect(coverageCopy('unchecked', { checksOff: true }).detail).toMatch(/cannot confirm/);
  });
  it('names the device (computer by default, phone on Android)', () => {
    expect(coverageCopy('device').detail).toMatch(/^All apps on this computer go through the VPN\./);
    expect(coverageCopy('device', { scope: { place: 'this phone' } }).detail).toMatch(/^All apps on this phone go through the VPN\./);
  });
  it('says what the per-app split leaves out', () => {
    const one = coverageCopy('device', { scope: { place: 'this phone', split: { mode: 'exclude', count: 1 } } }).detail;
    expect(one).toMatch(/except the one you chose/);
    const two = coverageCopy('device', { scope: { place: 'this phone', split: { mode: 'exclude', count: 2 } } }).detail;
    expect(two).toMatch(/except the 2 you chose/);
    const only = coverageCopy('device', { scope: { place: 'this phone', split: { mode: 'include', count: 3 } } }).detail;
    expect(only).toMatch(/^Only the 3 apps you chose go through the VPN; other apps use your normal connection\./);
    expect(coverageCopy('device', { scope: { split: { mode: 'include', count: 1 } } }).detail).toMatch(/^Only the app you chose goes through/);
  });
  it('an empty split list reads as every app', () => {
    expect(coverageCopy('device', { scope: { place: 'this phone', split: { mode: 'exclude', count: 0 } } }).detail).toMatch(/^All apps on this phone go through the VPN\./);
  });
});

describe('node address wins (app started during a tunnel: own IP not known yet)', () => {
  it('full tunnel exiting at the node is the whole device even without a home IP', () => {
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: NODE, homeIp: null, nodeIp: NODE })).toBe('device');
  });
  it('a wrong home IP equal to the node never reads as leaking', () => {
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: NODE, homeIp: NODE, nodeIp: NODE })).toBe('device');
  });
  it('proxy exit at the node covers browsers', () => {
    expect(coverageOf({ proxyEndpoint: '127.0.0.1:1080', proxyActive: true, directIp: HOME, proxyIp: NODE, homeIp: null, nodeIp: NODE })).toBe('proxy-apps');
  });
});

describe('coverage with split tunnelling', () => {
  it('include: this app sees the home IP by design, still protected for the chosen apps', async () => {
    const { coverageOf, coverageCopy } = await import('../../src/core/session/coverage');
    const c = coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: '1.2.3.4', homeIp: '1.2.3.4', nodeIp: '9.9.9.9', split: 'include' });
    expect(c).toBe('split-include');
    expect(coverageCopy(c).ok).toBe(true);
  });
  it('exclude: checked like a full tunnel, titled as split', async () => {
    const { coverageOf } = await import('../../src/core/session/coverage');
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: '9.9.9.9', homeIp: '1.2.3.4', nodeIp: '9.9.9.9', split: 'exclude' })).toBe('split-exclude');
    // The check itself may be left out (its addresses or this app): not a proven leak, never "Protected".
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: '1.2.3.4', homeIp: '1.2.3.4', nodeIp: '9.9.9.9', split: 'exclude' })).toBe('split-exclude-unconfirmed');
    const { coverageCopy } = await import('../../src/core/session/coverage');
    const copy = coverageCopy('split-exclude-unconfirmed', { homeIp: '1.2.3.4' });
    expect(copy.ok).toBe(false);
    expect(copy.title).not.toMatch(/Protected/);
    expect(copy.detail).toContain('1.2.3.4');
    // Without a split, a home-IP reading is still a leak.
    expect(coverageOf({ proxyEndpoint: '', proxyActive: false, directIp: '1.2.3.4', homeIp: '1.2.3.4', nodeIp: '9.9.9.9' })).toBe('leaking');
  });
});
