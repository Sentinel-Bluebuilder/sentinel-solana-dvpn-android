// ─── cb33 daemon layout + the one instance config.toml (shared across the desktop apps) ───
// Fixture tests/fixtures/cb33-c0-config.toml is the real file `sentinel-dvpnd init --instance c0`
// wrote (fork-cb33-1-rc, owner = a dummy address). Legacy fixtures are the pre-cb33 pair.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLIENT_INSTANCE, DAEMON_GROUP, daemonBinaryName, daemonEndpoint, doctorArgs, firewallObject, initArgs, instanceDir,
  keyListArgs, legacyHome, operatorKey, serviceArgs, runArgs, androidInstanceDir, androidEndpoint, androidLegacyHome, serviceEnvFile, serviceName, stateRoot, tunnelInterface,
} from '../../src/core/daemon/layout';
import { carrySettingsInto, parseConfig, readToml, renderConfig, type DaemonSettings } from '../../src/core/daemon/config';

const fx = (f: string): string => fs.readFileSync(path.join(__dirname, '../fixtures', f), 'utf8');
const C0 = fx('cb33-c0-config.toml');

describe('cb33 layout per OS (instance.go on fork-cb33-1)', () => {
  it('names', () => {
    expect(CLIENT_INSTANCE).toBe('c0');
    expect(DAEMON_GROUP).toBe('sentinel-dvpn');
    expect(daemonBinaryName('linux')).toBe('sentinel-dvpnd');
    expect(daemonBinaryName('win32')).toBe('sentinel-dvpnd.exe');
    expect(tunnelInterface()).toBe('dvpn-c0');
    expect(firewallObject()).toBe('sentinel-dvpn-c0');
    expect(serviceEnvFile()).toBe('/etc/sentinel-dvpn/c0.env');
  });
  it('paths and services', () => {
    expect(stateRoot('linux')).toBe('/var/lib/sentinel-dvpn');
    expect(instanceDir('linux')).toBe('/var/lib/sentinel-dvpn/c0');
    expect(daemonEndpoint('linux')).toBe('/var/lib/sentinel-dvpn/c0/daemon.sock');
    expect(serviceName('linux')).toBe('sentinel-dvpnd@c0');
    expect(instanceDir('darwin')).toBe('/Library/Application Support/sentinel-dvpn/c0');
    expect(daemonEndpoint('darwin')).toBe('/Library/Application Support/sentinel-dvpn/c0/daemon.sock');
    expect(serviceName('darwin')).toBe('co.sentinel.sentinel-dvpnd.c0');
    expect(instanceDir('win32', 'c0', 'D:\\Data\\')).toBe('D:\\Data\\sentinel-dvpn\\c0');
    expect(daemonEndpoint('win32')).toBe('\\\\.\\pipe\\ProtectedPrefix\\Administrators\\sentinel-dvpn\\c0');
    expect(serviceName('win32')).toBe('sentinel-dvpnd$c0');
    expect(legacyHome('linux')).toBe('/var/lib/dvpnd/client');
  });
  it('refuses a bad instance tag', () => {
    expect(() => instanceDir('linux', '../x')).toThrow();
    expect(() => serviceName('linux', 'c0; rm')).toThrow();
  });
  it('CLI arguments: --instance c0, no --role', () => {
    expect(initArgs('/s/c0', 'Own1')).toEqual(['init', '--instance', 'c0', '--home', '/s/c0', '--owner', 'Own1', '--plain-key']);
    expect(keyListArgs()).toEqual(['key', 'list', '--instance', 'c0']);
    expect(keyListArgs('/h')).toEqual(['key', 'list', '--instance', 'c0', '--home', '/h']);
    expect(doctorArgs('/h')).toEqual(['doctor', '--instance', 'c0', '--home', '/h']);
    expect(serviceArgs('install')).toEqual(['service', 'install', '--instance', 'c0']);
    expect(initArgs('/s', 'O').join(' ')).not.toContain('--role');
    // Android: DaemonProcess.kt runs the same args (ProtocolBitsTest.kt checks the Kotlin side)
    expect(runArgs('/h')).toEqual(['run', '--instance', 'c0', '--home', '/h']);
  });
  it('Android row: the c0 home in the app files dir', () => {
    expect(androidInstanceDir('/data/user/0/x/files/')).toBe('/data/user/0/x/files/sentinel-dvpn/c0');
    expect(androidEndpoint('/data/user/0/x/files')).toBe('/data/user/0/x/files/sentinel-dvpn/c0/daemon.sock');
    expect(androidLegacyHome('/f')).toBe('/f/dvpnd/client');
    // a unix socket path must stay under 108 bytes; a long package name still fits
    expect(androidEndpoint('/data/user/0/network.sentinel.devnetdvpn/files').length).toBeLessThan(108);
    expect(() => androidInstanceDir('/f', '../x')).toThrow();
  });
  it('operator key, or the device key of an old home', () => {
    expect(operatorKey([{ name: 'other' }, { name: 'operator', pk: 1 }])).toEqual({ name: 'operator', pk: 1 });
    expect(operatorKey([{ name: 'device', pk: 2 }])).toEqual({ name: 'device', pk: 2 });
    expect(operatorKey([{ name: 'other' }])).toBeUndefined();
  });
});

const SETTINGS: DaemonSettings = {
  killSwitch: 'on', allowLan: true, dnsServers: ['9.9.9.9'], dnsMode: 'resolvconf', basis: 'per_hour',
  escrow: '5000000', prepayBytes: '0', prepaySeconds: '120',
  rpcUrl: 'https://rpc.example.org', rpcWsUrl: 'wss://rpc.example.org',
  split: { mode: 'exclude', apps: ['/usr/bin/firefox'], routes: ['10.0.0.0/8'] },
};

describe('the one instance config.toml', () => {
  it('reads the settings init wrote', () => {
    const s = parseConfig(C0);
    expect(s.killSwitch).toBe('on');
    expect(s.basis).toBe('per_gb');
    expect(s.escrow).toBe('1000000000');
    expect(s.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(s.dnsServers).toEqual(['1.1.1.1', '1.0.0.1']);
  });
  it('writes every setting into the same file, in its own section, and reads them back', () => {
    const out = renderConfig(C0, SETTINGS);
    expect(readToml(out, '', 'basis')).toBe('per_hour');
    expect(readToml(out, '', 'escrow_base_units')).toBe('5000000');
    expect(readToml(out, 'network', 'kill_switch')).toBe('persist'); // Q0426: On = persist
    expect(readToml(out, 'network', 'dns_backend')).toBe('resolvconf');
    expect(readToml(out, 'split', 'apps')).toEqual(['/usr/bin/firefox']);
    expect(readToml(out, 'rpc', 'url')).toBe('https://rpc.example.org');
    // nothing cb33 does not read: no socket_group, no stray section, the rest of the file kept
    expect(out).not.toContain('socket_group');
    expect(out.match(/^\[rpc\]$/gm)).toHaveLength(1);
    expect(out).toContain("[tx.paymaster]\napi_key = ''");
    expect(out).toContain("[key]\nname = 'operator'");
    expect(parseConfig(out)).toMatchObject({ killSwitch: 'persist', allowLan: true, prepaySeconds: '120', rpcWsUrl: 'wss://rpc.example.org' });
  });
  it('a top-level key init did not write goes above the first section', () => {
    const noBasis = C0.replace("basis = 'per_gb'\n", '');
    const out = renderConfig(noBasis, SETTINGS);
    expect(out.indexOf("basis = 'per_hour'")).toBeLessThan(out.indexOf('[key]'));
    expect(readToml(out, '', 'basis')).toBe('per_hour');
  });
});

describe('carrying an old home into the c0 instance', () => {
  const old = { root: fx('dvpnd-root.config.toml'), client: fx('dvpnd-client.v2.config.toml') };
  it('the user settings arrive, owner and key stay the new ones, on becomes persist', () => {
    const out = carrySettingsInto(old, C0);
    const was = { ...parseConfig(old.root), ...parseConfig(old.client) };
    const now = parseConfig(out);
    expect(now.allowLan).toBe(readToml(old.client, 'network', 'allow_lan') === true);
    expect(now.dnsServers).toEqual(was.dnsServers);
    if (readToml(old.root, 'rpc', 'url') !== null) expect(now.rpcUrl).toBe(readToml(old.root, 'rpc', 'url'));
    // off stays off; on, persist, or nothing set (init's default 'on') all end as persist
    expect(now.killSwitch).toBe(was.killSwitch === 'off' ? 'off' : 'persist');
    expect(readToml(out, '', 'owner')).toBe('11111111111111111111111111111111');
    expect(readToml(out, 'key', 'name')).toBe('operator');
    expect(out).not.toContain('socket_group');
  });
  it('an old "on" always arrives as persist (Q0426); off stays off', () => {
    const on = { root: '', client: "[network]\nkill_switch = 'on'\n" };
    const off = { root: '', client: "[network]\nkill_switch = 'off'\n" };
    expect(readToml(carrySettingsInto(on, C0), 'network', 'kill_switch')).toBe('persist');
    expect(readToml(carrySettingsInto(off, C0), 'network', 'kill_switch')).toBe('off');
  });
  it('a cb33 file passed as both halves carries into another (wallet switch)', () => {
    const mine = renderConfig(C0, SETTINGS);
    const out = carrySettingsInto({ root: mine, client: mine }, C0);
    expect(parseConfig(out)).toMatchObject({ basis: 'per_hour', rpcUrl: 'https://rpc.example.org', killSwitch: 'persist' });
    expect(out.match(/^\[network\]$/gm)).toHaveLength(1);
  });
});

// ─── cb33 protocol bits: all six, through the decoder every screen and the CLI use ───
import { protocolNames } from '../../src/core/chain/idl';
describe('protocol bits (cb33 table)', () => {
  it('decodes each of the six bits to its cb33 protocol', () => {
    const want: Array<[number, string]> = [[1, 'wireguard'], [2, 'v2ray'], [4, 'openvpn'], [8, 'amneziawg'], [16, 'xray'], [32, 'hysteria2']];
    for (const [bit, name] of want) expect(protocolNames(bit), String(bit)).toEqual([name]);
    expect(protocolNames(63)).toEqual(want.map(([, n]) => n));
    // a node with wireguard + hysteria2 (the old table read 33 as wireguard + amneziawg)
    expect(protocolNames(33)).toEqual(['wireguard', 'hysteria2']);
  });
});
