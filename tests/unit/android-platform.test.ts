// ─── Android platform layer: pure parts (no phone needed) ───
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSettings, readToml, renderConfigs, validateSettings, type DaemonSettings } from '../../src/core/daemon/config';
import { androidReport, driverLines } from '../../src/main/system/drivers';
import { isAndroid, abstractPath } from '../../src/main/platform/android-bridge';

describe('android drivers report', () => {
  it('is ok when every bundled program is linked', () => {
    const r = androidReport('/files/bin', () => true);
    expect(r.ok).toBe(true);
    expect(r.deps.map((d) => d.name)).toEqual(['wireguard', 'amneziawg', 'dvpnd', 'v2ray', 'xray', 'hysteria2', 'openvpn']);
    expect(driverLines(r).every((l) => l.startsWith('ok'))).toBe(true);
  });

  it('names the missing program and is not ok', () => {
    const r = androidReport('/files/bin', (p) => !p.endsWith('/xray'));
    expect(r.ok).toBe(false);
    const xray = r.deps.find((d) => d.name === 'xray');
    expect(xray?.status).toBe('missing');
    expect(driverLines(r).find((l) => l.includes('Xray'))).toMatch(/^miss/);
  });
});

// Captured from the API 34 emulator (`dvpnd init --role client`, Android build).
const AROOT = readFileSync('tests/fixtures/dvpnd-root.android.config.toml', 'utf8');
const ACLIENT = readFileSync('tests/fixtures/dvpnd-client.android.config.toml', 'utf8');

describe('android daemon config', () => {
  const live = parseSettings(AROOT, ACLIENT) as DaemonSettings;

  it('reads the Android defaults (dns backend vpn, prepay not set)', () => {
    expect(live.dnsMode).toBe('vpn');
    expect(live.prepayBytes).toBe('0');
    expect(live.prepaySeconds).toBe('0');
  });

  it('accepts the live config as it is, so one-flag `daemon set` works', () => {
    expect(() => validateSettings(live, { android: true })).not.toThrow();
  });

  it('refuses desktop DNS backends on Android and vpn on desktop', () => {
    expect(() => validateSettings({ ...live, dnsMode: 'netsh' }, { android: true })).toThrow(/DNS mode must be one of vpn, none/);
    expect(() => validateSettings({ ...live, dnsMode: 'vpn' }, { android: false })).toThrow(/DNS mode/);
  });

  it('never writes the Windows socket group on Android', () => {
    const out = renderConfigs(AROOT, ACLIENT, { ...live, allowLan: true }, { android: true });
    expect(readToml(out.root, 'daemon', 'socket_group')).toBe('');
    expect(readToml(out.client, 'network', 'allow_lan')).toBe(true);
    expect(readToml(out.client, 'network', 'dns_backend')).toBe('vpn');
    const desktop = renderConfigs(AROOT, ACLIENT, { ...live, dnsMode: 'none' }, { android: false });
    expect(readToml(desktop.root, 'daemon', 'socket_group')).toBe('Users');
  });

  it('still refuses a zero escrow', () => {
    expect(() => validateSettings({ ...live, escrow: '0' }, { android: true })).toThrow(/deposit must be a positive/);
  });
});

describe('android detection + bridge path', () => {
  const saved = process.env.DVPN_PLATFORM;
  afterEach(() => {
    if (saved === undefined) delete process.env.DVPN_PLATFORM;
    else process.env.DVPN_PLATFORM = saved;
  });

  it('is android only when the app says so (or Node is the Android build)', () => {
    delete process.env.DVPN_PLATFORM;
    expect(isAndroid()).toBe(process.platform === 'android');
    process.env.DVPN_PLATFORM = 'android';
    expect(isAndroid()).toBe(true);
  });

  it('dials the abstract namespace', () => {
    expect(abstractPath('ddv-app-1a2b')).toBe('\0ddv-app-1a2b');
  });
});

// ─── Per-app split tunnelling (split show / apps / set, Split screen) ───
import { validateSplit, validateRoutes, validRoute, splitGet, SPLIT_DESKTOP } from '../../src/main/system/split-apps';
import { coverageCopy } from '../../src/core/session/coverage';

describe('android split tunnelling', () => {
  it('normalises the package list (sorted, unique)', () => {
    expect(validateSplit('exclude', ['org.mozilla.firefox', 'com.android.chrome', 'org.mozilla.firefox']))
      .toEqual({ mode: 'exclude', packages: ['com.android.chrome', 'org.mozilla.firefox'], routeMode: 'all', routes: [] });
  });

  it('"all" carries no packages', () => {
    expect(validateSplit('all', ['com.android.chrome'])).toEqual({ mode: 'all', packages: [], routeMode: 'all', routes: [] });
  });

  it('refuses "only these apps" with no app (it would route every app)', () => {
    expect(() => validateSplit('include', [])).toThrow(/at least one app/);
  });

  it('refuses unknown modes and bad package names', () => {
    expect(() => validateSplit('some', [])).toThrow(/all, include, exclude/);
    expect(() => validateSplit('exclude', ['chrome'])).toThrow(/Not an Android package name: chrome/);
    expect(() => validateSplit('exclude', ['com.x;rm -rf'])).toThrow(/Not an Android package name/);
  });

  it('split by address: accepts IPs and networks, sorted and unique, comma or separate', () => {
    expect(validateRoutes('include', ['10.0.0.0/8,1.1.1.1', ' 2001:db8::/32 ', '1.1.1.1']))
      .toEqual({ routeMode: 'include', routes: ['1.1.1.1', '10.0.0.0/8', '2001:db8::/32'] });
    expect(validateRoutes('all', ['10.0.0.0/8'])).toEqual({ routeMode: 'all', routes: [] });
  });

  it('split by address: refuses junk, too-wide prefixes, empty include and unknown modes', () => {
    for (const bad of ['example.com', '10.0.0.0/33', '256.1.1.1', '1.2.3', '1.1.1.1/x', '1.1.1.1/8/8', '::1::2', "'; rm -rf /", '1.1.1.1\u0000']) expect(validRoute(bad)).toBe(false);
    expect(() => validateRoutes('exclude', ['example.com'])).toThrow(/Not an IP address or network/);
    expect(() => validateRoutes('include', [])).toThrow(/at least one address/);
    expect(() => validateRoutes('some', [])).toThrow(/all, include, exclude/);
    expect(() => validateRoutes('exclude', Array.from({ length: 201 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`))).toThrow(/At most 200/);
  });

  it('coverage copy says when only some addresses use the VPN', () => {
    const inc = coverageCopy('device', { scope: { place: 'this phone', split: { mode: 'all', count: 0, routeMode: 'include', routeCount: 2 } } });
    expect(inc.detail).toMatch(/Only traffic to the 2 addresses you chose uses the VPN/);
    const exc = coverageCopy('device', { scope: { place: 'this phone', split: { mode: 'all', count: 0, routeMode: 'exclude', routeCount: 1 } } });
    expect(exc.detail).toMatch(/the address you chose uses your normal connection/);
  });

  it('on the desktop, points at the proxy instead', async () => {
    const was = process.env.DVPN_PLATFORM;
    delete process.env.DVPN_PLATFORM;
    try {
      if (process.platform !== 'android') await expect(splitGet()).rejects.toThrow(SPLIT_DESKTOP);
    } finally {
      if (was !== undefined) process.env.DVPN_PLATFORM = was;
    }
  });
});

describe('split app icons (drawn by the app shell)', () => {
  it('keeps a small base64 PNG and drops anything else', async () => {
    const { iconOf } = await import('../../src/main/system/split-apps');
    expect(iconOf('iVBORw0KGgoAAAANSUhEUg==')).toBe('iVBORw0KGgoAAAANSUhEUg==');
    for (const bad of ['', 'javascript:alert(1)', '<svg/>', 'iVBORw0KGgo"onerror', 'R0lGODlh', 42, null, 'iVBORw0KGgo' + 'A'.repeat(40_000)]) {
      expect(iconOf(bad)).toBeUndefined();
    }
  });
});
