// ─── [split] in the dvpnd client config: render, read back, validate (dvpnd rc+) ───
import { describe, expect, it } from 'vitest';
import { parseSettings, renderConfigs, validateSplit, type DaemonSettings } from '../../src/core/daemon/config';

const base: DaemonSettings = {
  killSwitch: 'off',
  allowLan: false,
  dnsServers: ['1.1.1.1'],
  basis: 'per_gb',
  escrow: '1000000',
  prepayBytes: '100000000',
  prepaySeconds: '600',
  rpcUrl: 'https://api.devnet.solana.com',
  rpcWsUrl: 'wss://api.devnet.solana.com',
};

describe('split config', () => {
  it('renders [split] and reads it back, Windows paths kept as written', () => {
    const split = { mode: 'include' as const, apps: ['C:\\Program Files\\Mozilla Firefox\\firefox.exe'], routes: ['10.0.0.0/8', '2001:db8::/32'] };
    const out = renderConfigs('', 'basis = \'per_gb\'\n', { ...base, split });
    expect(out.client).toContain('[split]');
    expect(out.client).toContain("apps = ['C:\\Program Files\\Mozilla Firefox\\firefox.exe']");
    expect(parseSettings(out.root, out.client).split).toEqual(split);
  });

  it('leaves [split] alone when not given, and replaces it in place when given', () => {
    const first = renderConfigs('', '', { ...base, split: { mode: 'exclude', apps: [], routes: ['1.2.3.4/32'] } }).client;
    expect(renderConfigs('', first, base).client).toContain("routes = ['1.2.3.4/32']");
    const second = renderConfigs('', first, { ...base, split: { mode: 'off', apps: [], routes: [] } }).client;
    expect(second.match(/\[split\]/g)).toHaveLength(1);
    expect(parseSettings('', second).split).toEqual({ mode: 'off', apps: [], routes: [] });
  });

  it('refuses what dvpnd would refuse', () => {
    const ok = { mode: 'include' as const, apps: ['C:\\a\\b.exe'], routes: [] };
    expect(() => validateSplit(ok)).not.toThrow();
    expect(() => validateSplit({ ...ok, apps: ['/usr/bin/firefox'] })).not.toThrow();
    expect(() => validateSplit({ ...ok, mode: 'all' as never })).toThrow(/mode/);
    expect(() => validateSplit({ ...ok, apps: ['firefox.exe'] })).toThrow(/full path/);
    expect(() => validateSplit({ ...ok, apps: ['C:\\a\\b.txt'] })).toThrow(/\.exe/);
    expect(() => validateSplit({ ...ok, apps: ["C:\\a'b.exe"] })).toThrow(/quote/);
    expect(() => validateSplit({ ...ok, apps: [], routes: ['10.0.0.0'] })).toThrow(/IP address or range/);
    expect(() => validateSplit({ ...ok, apps: [], routes: ['10.0.0.0/33'] })).toThrow(/IP address or range/);
    expect(() => validateSplit({ ...ok, apps: [], routes: ['example.com'] })).toThrow(/not a name/);
    expect(() => validateSplit({ mode: 'exclude', apps: [], routes: [] })).toThrow(/at least one/);
    expect(() => validateSplit({ mode: 'off', apps: [], routes: [] })).not.toThrow();
  });
});
