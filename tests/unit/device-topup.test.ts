// ─── Automatic device SOL top-up before a connect ───
// Soak 2026-10-21: ~50 small per-GB connects drained the device (each new deposit account holds
// ~0.004 SOL of rent until settled) and every later connect stopped at "needs a little SOL".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deviceTopUpLamports, DEVICE_SOL_TARGET, OWNER_SOL_RESERVE } from '../../src/core/app/device-setup';
import { DEVICE_SOL_MIN } from '../../src/core/pricing/cost';

const state = vi.hoisted(() => ({ autoTopUpDevice: true, key: true, sent: [] as number[], fail: false, toasts: [] as string[] }));
vi.mock('../../src/main/system/settings', () => ({ getSettings: () => ({ autoTopUpDevice: state.autoTopUpDevice }) }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerKeypair: () => (state.key ? {} : null), ownerSigner: () => ({}) }));
vi.mock('../../src/main/app-state', () => ({ toast: (_k: string, m: string) => { state.toasts.push(m); } }));
vi.mock('../../src/main/logger', () => ({ log: { info: () => undefined, warn: () => undefined } }));
vi.mock('../../src/core/app/device-setup', async (orig) => ({
  ...(await orig<typeof import('../../src/core/app/device-setup')>()),
  sendDeviceSol: async (_s: unknown, _d: string, l: number) => { if (state.fail) throw new Error('rpc down\nstack'); state.sent.push(l); return 'sig1'; },
}));
const { topUpDeviceIfLow } = await import('../../src/main/services/device-topup');

const wallet = (deviceLamports: number, ownerLamports: number) => ({ deviceLamports, ownerLamports }) as Parameters<typeof topUpDeviceIfLow>[0];

describe('deviceTopUpLamports', () => {
  it('nothing when the device has enough', () => expect(deviceTopUpLamports(DEVICE_SOL_MIN, 0)).toBe(0));
  it('fills back to the target', () => expect(deviceTopUpLamports(4_086_280, 10e9)).toBe(DEVICE_SOL_TARGET - 4_086_280));
  it('null when the owner cannot spare it and keep its own fees', () => {
    expect(deviceTopUpLamports(0, DEVICE_SOL_TARGET + OWNER_SOL_RESERVE - 1)).toBeNull();
    expect(deviceTopUpLamports(0, DEVICE_SOL_TARGET + OWNER_SOL_RESERVE)).toBe(DEVICE_SOL_TARGET);
  });
});

describe('topUpDeviceIfLow', () => {
  beforeEach(() => { state.autoTopUpDevice = true; state.key = true; state.sent = []; state.fail = false; state.toasts = []; });
  it('sends and tells the user', async () => {
    expect(await topUpDeviceIfLow(wallet(1_000_000, 1e9), 'dev')).toMatchObject({ done: true, lamports: 49_000_000 });
    expect(state.sent).toEqual([49_000_000]);
    expect(state.toasts[0]).toMatch(/Sent this device 0\.049 SOL/);
  });
  it('not needed: nothing sent', async () => {
    expect(await topUpDeviceIfLow(wallet(DEVICE_SOL_TARGET, 1e9), 'dev')).toMatchObject({ done: false, reason: 'not-needed' });
    expect(state.sent).toEqual([]);
  });
  it('setting off: nothing sent', async () => {
    state.autoTopUpDevice = false;
    expect(await topUpDeviceIfLow(wallet(0, 1e9), 'dev')).toMatchObject({ reason: 'off' });
    expect(state.sent).toEqual([]);
  });
  it('no in-app key (browser wallet): never asks to sign', async () => {
    state.key = false;
    expect(await topUpDeviceIfLow(wallet(0, 1e9), 'dev')).toMatchObject({ reason: 'no-key' });
  });
  it('owner short: nothing sent', async () => {
    expect(await topUpDeviceIfLow(wallet(0, 10_000_000), 'dev')).toMatchObject({ reason: 'owner-short' });
    expect(state.sent).toEqual([]);
  });
  it('a failed send never throws', async () => {
    state.fail = true;
    expect(await topUpDeviceIfLow(wallet(0, 1e9), 'dev')).toMatchObject({ done: false, reason: 'failed', detail: 'rpc down' });
  });
});
