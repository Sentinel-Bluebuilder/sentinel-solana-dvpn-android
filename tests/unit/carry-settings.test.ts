// fleet-bugs W3: a wallet switch installed a fresh `dvpnd init` home, so the user's settings went
// back to dvpnd's defaults (kill switch came back ON on test-host, 2026-10-24).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { carrySettings, parseSettings, readToml, renderConfigs, DNS_PRESETS, type DaemonSettings } from '../../src/core/daemon/config';
import { carryLiveSettings } from '../../src/main/daemon/manager';

const ROOT = fs.readFileSync('tests/fixtures/dvpnd-root.v2.config.toml', 'utf8');
const CLIENT = fs.readFileSync('tests/fixtures/dvpnd-client.v2.config.toml', 'utf8');

const USER: DaemonSettings = {
  killSwitch: 'off',
  allowLan: true,
  dnsServers: DNS_PRESETS.handshake.servers,
  dnsMode: 'none',
  basis: 'per_hour',
  escrow: '5000000',
  prepayBytes: '500000000',
  prepaySeconds: '1800',
  rpcUrl: 'https://devnet.example-rpc.test/',
  rpcWsUrl: 'wss://devnet.example-rpc.test/',
  split: { mode: 'exclude', apps: ['C:\\Apps\\game.exe'], routes: ['10.0.0.0/8'] },
};

describe('carrySettings', () => {
  const old = renderConfigs(ROOT, CLIENT, USER);

  it('gives a fresh home the user settings of the old one', () => {
    const s = parseSettings(...Object.values(carrySettings(old, { root: ROOT, client: CLIENT })) as [string, string]);
    expect(s.killSwitch).toBe('off');
    expect(s.allowLan).toBe(true);
    expect(s.dnsServers).toEqual(DNS_PRESETS.handshake.servers);
    expect(s.dnsMode).toBe('none');
    expect(s.basis).toBe('per_hour');
    expect(s.escrow).toBe('5000000');
    expect(s.prepayBytes).toBe('500000000');
    expect(s.prepaySeconds).toBe('1800');
    expect(s.rpcUrl).toBe(USER.rpcUrl);
    expect(s.split).toEqual(USER.split);
  });

  it('writes numbers as TOML integers, not strings', () => {
    const out = carrySettings(old, { root: ROOT, client: CLIENT });
    expect(out.client).toMatch(/^escrow_base_units = 5000000$/m);
    expect(out.client).toMatch(/^prepay_seconds = 1800$/m);
  });

  it('keeps the fresh home identity (owner, keys) untouched', () => {
    const fresh = CLIENT.replace(/\r\n/g, '\n');
    const out = carrySettings(old, { root: ROOT, client: fresh });
    for (const line of fresh.split('\n').filter((l) => /owner|key|device/i.test(l) && l.includes('='))) {
      expect(out.client).toContain(line);
    }
  });

  it('changes nothing when the old home has no user keys', () => {
    expect(carrySettings({ root: '', client: '' }, { root: ROOT, client: CLIENT })).toEqual({ root: ROOT, client: CLIENT });
  });
});

describe('carryLiveSettings', () => {
  function home(root: string, client: string, xray?: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-w3-'));
    fs.mkdirSync(path.join(d, 'client', 'xray'), { recursive: true });
    fs.writeFileSync(path.join(d, 'config.toml'), root);
    fs.writeFileSync(path.join(d, 'client', 'config.toml'), client);
    if (xray !== undefined) fs.writeFileSync(path.join(d, 'client', 'xray', 'config.toml'), xray);
    return d;
  }

  it('copies settings and whole-device mode into the staged home', () => {
    const old = renderConfigs(ROOT, CLIENT, USER);
    const live = home(old.root, old.client, 'tun = true\n');
    const staging = home(ROOT, CLIENT, 'tun = false\n');
    carryLiveSettings(staging, live);
    const client = fs.readFileSync(path.join(staging, 'client', 'config.toml'), 'utf8');
    expect(readToml(client, 'network', 'kill_switch')).toBe('off');
    expect(readToml(fs.readFileSync(path.join(staging, 'client', 'xray', 'config.toml'), 'utf8'), '', 'tun')).toBe(true);
  });

  it('leaves the staged defaults when nothing is installed yet', () => {
    const staging = home(ROOT, CLIENT);
    carryLiveSettings(staging, path.join(os.tmpdir(), 'ddv-w3-none'));
    expect(fs.readFileSync(path.join(staging, 'client', 'config.toml'), 'utf8')).toBe(CLIENT);
  });
});
