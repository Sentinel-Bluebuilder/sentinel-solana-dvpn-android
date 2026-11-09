// ─── daemon install with no internet (port of the macOS app 0790fc2, rig 2 installer offline phase) ───
// The balances cannot be read offline. A wallet that already set up a device here may still repair
// the service; any other wallet gets the read error (nothing installed).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  owner: 'OwnerA' as string | null,
  record: null as { owner: string } | null,
  read: 'fail' as 'fail' | 'ready' | 'unready',
  installs: 0,
}));

vi.mock('../../src/cli/commands', async (orig) => ({
  ...(await orig<typeof import('../../src/cli/commands')>()),
  walletRead: vi.fn(async () => {
    if (state.read === 'fail') throw new Error('Could not read the balances of OwnerA right now (network or RPC busy). Try again in a moment.');
    return { ready: state.read === 'ready' };
  }),
}));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => state.owner }));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: vi.fn(), daemonInfo: vi.fn(), runDoctor: vi.fn(), initDevice: vi.fn(), uninstallService: vi.fn(),
  deviceRecord: () => state.record,
  installService: vi.fn(async () => { state.installs++; return { ok: true }; }),
}));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { daemonCmd } from '../../src/cli/daemon-cmd';
import { parseArgs } from '../../src/cli/args';

const out = { json: false, print: vi.fn() };
const install = (): Promise<void> => daemonCmd(parseArgs(['daemon', 'install', '--yes']), out);

describe('daemon install offline', () => {
  beforeEach(() => { state.owner = 'OwnerA'; state.record = null; state.read = 'fail'; state.installs = 0; });

  it('repairs when this wallet already set up the device here', async () => {
    state.record = { owner: 'OwnerA' };
    await install();
    expect(state.installs).toBe(1);
  });
  it('refuses with the read error when no device was set up', async () => {
    await expect(install()).rejects.toThrow(/Could not read the balances/);
    expect(state.installs).toBe(0);
  });
  it('refuses when the recorded device belongs to another wallet', async () => {
    state.record = { owner: 'OwnerB' };
    await expect(install()).rejects.toThrow(/Could not read the balances/);
    expect(state.installs).toBe(0);
  });
  it('online: a wallet that is not ready is still refused, even with a device record', async () => {
    state.record = { owner: 'OwnerA' }; state.read = 'unready';
    await expect(install()).rejects.toThrow(/device setup --yes/);
    expect(state.installs).toBe(0);
  });
  it('online and ready installs', async () => {
    state.read = 'ready';
    await install();
    expect(state.installs).toBe(1);
  });
});
