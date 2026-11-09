// ─── cb33 move of an old Android engine home (files/dvpnd/client → files/sentinel-dvpn/c0) ───
// The old key must arrive unchanged as keys/operator.json (cb33 init reuses it, so the device keeps its
// grant and deposits), only for the same wallet, with cb33's modes, and the old home must be kept.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/system/elevate', () => ({ runElevated: vi.fn() }));
vi.mock('../../src/main/store', () => ({ readJson: vi.fn(), writeJson: vi.fn() }));

import { migrateAndroidHome } from '../../src/main/daemon/manager';

const KEY = '[1,2,3,4]';

function oldHome(owner: string): { files: string; legacy: string; home: string } {
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-cb33-'));
  const legacy = path.join(files, 'dvpnd', 'client');
  fs.mkdirSync(path.join(legacy, 'client', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.toml'), "[rpc]\nurl = 'https://example.invalid'\n");
  fs.writeFileSync(path.join(legacy, 'client', 'config.toml'), `owner = '${owner}'\n[network]\nkill_switch = 'on'\n`);
  fs.writeFileSync(path.join(legacy, 'client', 'keys', 'device.json'), KEY, { mode: 0o600 });
  return { files, legacy, home: path.join(files, 'sentinel-dvpn', 'c0') };
}

describe('migrateAndroidHome', () => {
  it('same wallet: the key moves unchanged, cb33 modes, old home kept as .pre-cb33', () => {
    const { legacy, home } = oldHome('OwnerA');
    const kept = migrateAndroidHome(home, 'OwnerA', legacy);
    expect(kept).toBe(`${legacy}.pre-cb33`);
    expect(fs.readFileSync(path.join(home, 'keys', 'operator.json'), 'utf8')).toBe(KEY);
    expect(fs.existsSync(path.join(kept, 'client', 'keys', 'device.json'))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(home).mode & 0o777).toBe(0o750);
      expect(fs.statSync(path.join(home, 'keys')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(home, 'keys', 'operator.json')).mode & 0o777).toBe(0o600);
    }
  });
  it("another wallet's home is left alone (fleet W1)", () => {
    const { legacy, home } = oldHome('OwnerA');
    expect(migrateAndroidHome(home, 'OwnerB', legacy)).toBe('');
    expect(fs.existsSync(path.join(legacy, 'client', 'keys', 'device.json'))).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
  });
  it('nothing to move: no old home, or the cb33 home already there', () => {
    const { legacy, home } = oldHome('OwnerA');
    expect(migrateAndroidHome(home, 'OwnerA', '')).toBe('');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), "owner = 'OwnerA'\n");
    expect(migrateAndroidHome(home, 'OwnerA', legacy)).toBe('');
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
