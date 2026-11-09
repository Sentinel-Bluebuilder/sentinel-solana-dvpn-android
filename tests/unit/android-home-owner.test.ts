// ─── Android wallet switch (fleet W1): which wallet an engine home acts for ───
// initAndroidDevice keeps a home only when its config.toml names the same wallet; another wallet
// moves it aside and gets a fresh device key. This pins the owner read it depends on.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { androidHomeOwner, homeOwner, keptHomeFor } from '../../src/main/daemon/manager';

function cfgWith(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-home-'));
  const f = path.join(dir, 'config.toml');
  fs.writeFileSync(f, text);
  return f;
}

describe('androidHomeOwner', () => {
  it('reads the owner dvpnd init wrote (single quotes, as on the phone)', () => {
    const f = cfgWith("[client]\nrole = 'client'\n\nowner = '11111111111111111111111111111111'\n");
    expect(androidHomeOwner(f)).toBe('11111111111111111111111111111111');
  });

  it('reads double quotes and indentation too', () => {
    expect(androidHomeOwner(cfgWith('  owner = "OwnerB"\n'))).toBe('OwnerB');
  });

  it('does not take a key that only ends in owner', () => {
    expect(androidHomeOwner(cfgWith("rent_owner = 'X'\n"))).toBe('');
  });

  it('is empty for a missing file (the home is then reused, as before)', () => {
    expect(androidHomeOwner(path.join(os.tmpdir(), 'no-such-ddv-home', 'config.toml'))).toBe('');
  });
});

describe('homeOwner (the phone layout: dvpnd writes the owner into <home>/client/config.toml)', () => {
  function phoneHome(owner: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-phone-'));
    fs.writeFileSync(path.join(home, 'config.toml'), "[log]\nlevel = 'info'\n"); // top config: no owner
    fs.mkdirSync(path.join(home, 'client'));
    fs.writeFileSync(path.join(home, 'client', 'config.toml'), `[client]\nrole = 'client'\nowner = '${owner}'\n`);
    return home;
  }

  it('reads the owner from the role folder, not the owner-less top config (rc1 W1 bug)', () => {
    expect(homeOwner(phoneHome('OwnerA'))).toBe('OwnerA');
  });

  it('still reads a home that has the owner in the top config', () => {
    const home = path.dirname(cfgWith("owner = 'OwnerT'\n"));
    expect(homeOwner(home)).toBe('OwnerT');
  });

  it('is empty for a missing home', () => {
    expect(homeOwner(path.join(os.tmpdir(), 'no-such-ddv-phone-home'))).toBe('');
  });

  it('keptHomeFor finds a kept phone-layout home by its role-folder owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-kept-phone-'));
    const kept = path.join(root, 'client.prev-2026-10-25T10-00-00-000Z');
    fs.renameSync(phoneHome('OwnerA'), kept);
    expect(keptHomeFor(path.join(root, 'client'), 'OwnerA')).toBe(kept);
    expect(keptHomeFor(path.join(root, 'client'), 'OwnerB')).toBe('');
  });
});

describe('keptHomeFor (switching back to a wallet used before)', () => {
  function keep(root: string, name: string, owner: string): void {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'config.toml'), `owner = '${owner}'\n`);
  }

  it('finds the newest kept home of that wallet and ignores other wallets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-kept-'));
    const home = path.join(root, 'dvpnd');
    keep(root, 'dvpnd.prev-2026-10-24T14-00-00-000Z', 'OwnerA');
    keep(root, 'dvpnd.prev-2026-10-24T15-00-00-000Z', 'OwnerA');
    keep(root, 'dvpnd.prev-2026-10-24T16-00-00-000Z', 'OwnerB');
    expect(keptHomeFor(home, 'OwnerA')).toBe(path.join(root, 'dvpnd.prev-2026-10-24T15-00-00-000Z'));
    expect(keptHomeFor(home, 'OwnerB')).toBe(path.join(root, 'dvpnd.prev-2026-10-24T16-00-00-000Z'));
  });

  it('is empty for a wallet never used here, and for a missing folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-kept-'));
    keep(root, 'dvpnd.prev-2026-10-24T14-00-00-000Z', 'OwnerA');
    expect(keptHomeFor(path.join(root, 'dvpnd'), 'OwnerC')).toBe('');
    expect(keptHomeFor(path.join(root, 'nope', 'dvpnd'), 'OwnerA')).toBe('');
  });
});
