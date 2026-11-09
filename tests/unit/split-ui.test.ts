// ─── Split tunnelling + kill switch page logic (pure parts) ───
import { describe, expect, it } from 'vitest';
import { filterApps, isChoosableExe, isStoreApp, mergeApps, normalizeRoute, sameNameApps } from '../../src/core/split/apps';
import { laneModel } from '../../src/core/split/lanes';
import { ksActiveStep, ksState, ksSteps, KS_STATE_COPY } from '../../src/core/session/ks-view';
import { lanRanges } from '../../src/core/net/lan';
import { parseAppsJson } from '../../src/main/system/apps';
import { splitSupportRows } from '../../src/cli/split-cmd';

const FF = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

describe('app list', () => {
  const shortcuts = [
    { name: 'Firefox', target: FF },
    { name: 'Firefox Private Browsing', target: FF },
    { name: 'Uninstall Firefox', target: 'C:\\Program Files\\Mozilla Firefox\\uninstall\\helper.exe' },
    { name: 'Google Chrome', target: CHROME },
    { name: 'Notepad', target: 'C:\\Windows\\System32\\notepad.exe' },
    { name: 'Readme', target: 'C:\\x\\readme.txt' },
  ];
  const procs = [{ name: 'Discord', path: 'C:\\Users\\u\\AppData\\Local\\Discord\\app-1\\Discord.exe' }, { name: 'Google Chrome', path: CHROME }];

  it('merges shortcuts + running apps, drops uninstallers, system tools and non-exe', () => {
    const apps = mergeApps(shortcuts, procs);
    expect(apps.map((a) => a.name)).toEqual(['Discord', 'Google Chrome', 'Firefox']);
    expect(apps.find((a) => a.path === CHROME)?.running).toBe(true);
    expect(apps.find((a) => a.path === FF)?.running).toBe(false);
  });

  it('keeps the shortest shortcut name and the exact path case', () => {
    const apps = mergeApps([{ name: 'Firefox Private Browsing', target: FF }, { name: 'Firefox', target: FF }], []);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: 'Firefox', path: FF });
  });

  it('always lists apps already chosen, even if gone from the Start Menu', () => {
    const apps = mergeApps([], [], ['D:\\Tools\\game.exe', 'not-a-path']);
    expect(apps).toEqual([{ path: 'D:\\Tools\\game.exe', name: 'game', running: false, source: 'picked' }]);
  });

  it('search matches name or folder; same-name programs are found', () => {
    const apps = mergeApps(shortcuts, procs, ['D:\\Portable\\firefox.exe']);
    expect(filterApps(apps, 'mozilla').map((a) => a.path)).toEqual([FF]);
    expect(filterApps(apps, '  ').length).toBe(apps.length);
    expect(sameNameApps(apps, FF).map((a) => a.path)).toEqual(['D:\\Portable\\firefox.exe']);
  });

  it('only full .exe paths dvpnd accepts are choosable; Store apps are flagged', () => {
    expect(isChoosableExe(FF)).toBe(true);
    expect(isChoosableExe('firefox.exe')).toBe(false);
    expect(isChoosableExe('C:\\a"b.exe')).toBe(false);
    expect(isStoreApp('C:\\Program Files\\WindowsApps\\X\\app.exe')).toBe(true);
  });

  it('parses list-apps.ps1 output, including a bare object for one item', () => {
    const one = parseAppsJson('\uFEFF{"shortcuts":{"name":"Firefox","target":"C:\\\\a.exe"},"procs":null}');
    expect(one).toEqual({ shortcuts: [{ name: 'Firefox', target: 'C:\\a.exe' }], procs: [] });
    expect(parseAppsJson('')).toEqual({ shortcuts: [], procs: [] });
  });
});

describe('address ranges', () => {
  it.each([
    ['10.0.0.0/8', '10.0.0.0/8'], ['192.168.1.5', '192.168.1.5/32'], [' 2001:db8::/32 ', '2001:db8::/32'],
    ['2001:DB8::1', '2001:db8::1/128'], ['10.0.0.0/33', null], ['300.1.1.1', null], ['example.com', null], ['1::2::3', null],
  ])('%s → %s', (i, o) => expect(normalizeRoute(i)).toBe(o));
});

describe('lane picture', () => {
  const name = (p: string): string => p.split('\\').pop()!.replace('.exe', '');
  it('include: chosen apps + ranges through the VPN, the rest direct', () => {
    const m = laneModel({ split: { mode: 'include', apps: [FF], routes: ['10.0.0.0/8'] }, liveService: 'xray', coverage: 'split-include', notApplied: null, appName: name });
    expect(m.vpn.map((x) => x.label)).toEqual(['firefox', '1 address range']);
    expect(m.direct.map((x) => x.label)).toEqual(['Every other app']);
    expect(m.applied).toBe(true);
  });
  it('exclude: the rest through the VPN, chosen apps direct', () => {
    const m = laneModel({ split: { mode: 'exclude', apps: [FF, CHROME], routes: [] }, liveService: null, coverage: null, notApplied: null, appName: name });
    expect(m.vpn.map((x) => x.label)).toEqual(['Every other app']);
    expect(m.direct.map((x) => x.path)).toEqual([FF, CHROME]);
    expect(m.live).toBe(false);
  });
  it('not applied by this protocol: every app on the VPN, with the reason', () => {
    const m = laneModel({ split: { mode: 'include', apps: [FF], routes: [] }, liveService: 'wireguard', coverage: 'device', notApplied: 'needs a newer service', appName: name });
    expect(m.vpn).toEqual([{ kind: 'rest', label: 'Every app' }]);
    expect(m.direct).toEqual([]);
    expect(m.note).toBe('needs a newer service');
  });
  it('proxy session: the measured truth wins over the setting', () => {
    const m = laneModel({ split: { mode: 'exclude', apps: [FF], routes: [] }, liveService: 'v2ray', coverage: 'proxy-only', notApplied: null, appName: name });
    expect(m.vpn[0].kind).toBe('proxy-apps');
    expect(m.note).toMatch(/Whole computer/);
  });
});

describe('kill switch page', () => {
  it('state: blocking beats everything; off; armed when connected; standby when not', () => {
    expect(ksState({ phase: 'idle', restoreNetwork: true, connected: false, saved: 'off' })).toBe('blocking');
    expect(ksState({ phase: 'reconnecting', restoreNetwork: false, connected: true, saved: 'on' })).toBe('blocking');
    expect(ksState({ phase: 'connected', restoreNetwork: false, connected: true, saved: 'off' })).toBe('off');
    expect(ksState({ phase: 'connected', restoreNetwork: false, connected: true, saved: 'on' })).toBe('armed');
    expect(ksState({ phase: 'idle', restoreNetwork: false, connected: false, saved: 'persist' })).toBe('standby');
    expect(KS_STATE_COPY.blocking.title).toBe('Blocking internet');
  });
  it('three steps per mode; the result step says what happens', () => {
    for (const m of ['off', 'on', 'persist'] as const) expect(ksSteps(m)).toHaveLength(3);
    expect(ksSteps('off')[2].text).toMatch(/Sites see your IP/);
    expect(ksSteps('on')[2].text).toMatch(/blocked until the VPN reconnects/);
    expect(ksSteps('persist')[2].text).toMatch(/even after a restart/);
  });
  it('active step', () => {
    expect(ksActiveStep('blocking', false)).toBe(2);
    expect(ksActiveStep('armed', true)).toBe(0);
    expect(ksActiveStep('standby', false)).toBe(-1);
  });
  it('local network ranges: private IPv4 only, no VPN adapters, no loopback', () => {
    expect(lanRanges({
      'Wi-Fi': [{ address: '192.168.1.183', netmask: '255.255.255.0', family: 'IPv4', internal: false }, { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', internal: false }],
      'vEthernet (WSL)': [{ address: '172.20.48.1', netmask: '255.255.240.0', family: 4, internal: false }],
      'dvpn-wg-client': [{ address: '10.8.0.2', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
      'Loopback': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      Public: [{ address: '34.1.2.3', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    })).toEqual(['172.20.48.0/20', '192.168.1.0/24']);
  });
});

describe('split status CLI rows', () => {
  it('one row per protocol from splitNotApplied (no rules copied here)', () => {
    const rows = splitSupportRows({ daemonVersion: 'cf4c372-rc', killSwitch: 'off', wholeDevice: true, hasApps: true, platform: 'win32' });
    expect(rows.map((r) => r.protocol)).toEqual(['wireguard', 'amneziawg', 'openvpn', 'v2ray', 'xray', 'hysteria2']);
    expect(rows.every((r) => r.reason === null)).toBe(true);
    const old = splitSupportRows({ daemonVersion: 'cf4c372-rc', hasApps: true, platform: 'win32' });
    expect(old.every((r) => typeof r.reason === 'string')).toBe(true);
  });
});

describe('kill switch: switching servers (gap #67, fixed in rc)', () => {
  it('no page warns that a switch leaks any more (kesw18b: 0 direct samples)', async () => {
    const fs = await import('node:fs');
    for (const f of ['src/renderer/src/screens/KillSwitch.tsx', 'src/renderer/src/components/ConnectSheet.tsx']) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/KS_SWITCH_NOTE|briefly uses your normal connection/);
    }
  });
});
