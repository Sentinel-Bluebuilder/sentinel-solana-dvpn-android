// ─── Gap #95: remove another device and settle its deposits ───
// A computer that is gone (key lost) left a grant and deposits stuck in "closing" (Phase 8,
// 2026-10-24). The owner can now remove it and settle its deposits, but only once it can no longer
// spend: closing the deposits of a device that may be live elsewhere could cut its session.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real on-curve addresses: the device check parses them (isWalletAddress needs a key on the curve).
const { OWNER, MINE, LOST } = vi.hoisted(() => ({
  OWNER: '7agSTgUnxYSim28TWXQ12mPy2XE8xrAuEKUHhYMSdvLL',
  MINE: '7DTn37iX1DSZj84sqY8iFcXm2whGASuzRsVdFEYeMdab',
  LOST: '11111111111111111111111111111111',
}));

const s = vi.hoisted(() => ({
  grants: new Map<string, unknown>(),
  rows: [] as Array<Record<string, unknown>>,
  sent: [] as string[],
  revoked: [] as string[],
}));
vi.mock('../../src/core/chain/accounts', () => ({
  channelsByOwner: async () => s.rows,
  userByOwner: async () => null,
}));
vi.mock('../../src/core/chain/program', () => ({ fetchConfig: async () => ({ channelCloseGraceSeconds: 7200 }) }));
vi.mock('../../src/core/chain/builders', () => ({
  startCloseChannel: async ({ channel }: { channel: string }) => `start:${channel}`,
  closeChannel: async ({ ch }: { ch: { address: string } }) => `close:${ch.address}`,
  withdrawUserBalance: vi.fn(),
}));
vi.mock('../../src/core/app/signer', () => ({ signAndSend: async (_s: unknown, ixs: string[]) => { s.sent.push(...ixs); return { signature: `sig-${s.sent.length}` }; } }));
vi.mock('../../src/core/app/wallet-status', () => ({
  readWalletStatus: async (_owner: string, device: string) => ({ grant: s.grants.get(device) ?? null }),
  lowFundsWarnings: () => [],
}));
vi.mock('../../src/core/app/device-setup', () => ({
  planDeviceSetup: vi.fn(), runDeviceSetup: vi.fn(),
  revokeDevice: async (_signer: unknown, device: string) => { s.revoked.push(device); s.grants.delete(device); return 'revoke-sig'; },
}));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => OWNER, ownerSigner: () => ({}) }));
vi.mock('../../src/main/daemon/manager', () => ({
  daemon: () => ({ listSessions: async () => [], listChannels: async () => [] }),
  daemonInfo: () => ({ reachable: true, device: MINE }),
  startServiceIfStopped: vi.fn(),
}));
vi.mock('../../src/main/app-state', () => ({ patch: vi.fn(), snapshot: () => ({ session: null }), toast: vi.fn() }));
vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { readSettlements, runSettlement } = await import('../../src/main/services/settlement');
const { revokeOtherDevice } = await import('../../src/main/services/wallet');

const chan = (address: string, opener: string, status: number, closeStartedAt = '0') =>
  ({ address, owner: OWNER, node: 'N', opener, mode: 0, status, escrow: '1000', redeemed: '0', closeStartedAt, rentPayer: opener });

beforeEach(() => {
  s.grants = new Map([[MINE, { allowance: '1' }], [LOST, { allowance: '1' }]]);
  s.rows = [chan('mine-open', MINE, 0), chan('lost-open', LOST, 0), chan('lost-ready', LOST, 1, '1')];
  s.sent = [];
  s.revoked = [];
});

describe('settle another device (gap #95)', () => {
  it('without --device only this computer\'s deposits are listed', async () => {
    expect((await readSettlements()).map((p) => p.channel)).toEqual(['mine-open']);
  });
  it('refuses while the other device can still spend', async () => {
    await expect(readSettlements(LOST)).rejects.toThrow(/can still spend.*device revoke --device/);
    // The app maps this code to its own words (Wallet → Other devices), not the CLI hint.
    await expect(readSettlements(LOST)).rejects.toMatchObject({ code: 'device-active' });
    const r = await runSettlement(undefined, LOST);
    expect(r.ok).toBe(false);
    expect(s.sent).toEqual([]);
  });
  it('refuses this computer\'s own device as "another" device', async () => {
    await expect(readSettlements(MINE)).rejects.toThrow(/this computer/);
  });
  it('after removal: only that device\'s deposits, start_close for open, close for ready', async () => {
    s.grants.delete(LOST);
    expect((await readSettlements(LOST)).map((p) => `${p.channel}:${p.status}`)).toEqual(['lost-open:open', 'lost-ready:ready']);
    const r = await runSettlement(undefined, LOST);
    expect(r.ok).toBe(true);
    expect(s.sent).toEqual(['start:lost-open', 'close:lost-ready']);
  });
});

describe('remove another device (gap #95)', () => {
  it('rejects a bad address and this computer\'s own device', async () => {
    expect((await revokeOtherDevice('not-an-address')).code).toBe('bad-device');
    expect((await revokeOtherDevice(MINE)).code).toBe('own-device');
    expect(s.revoked).toEqual([]);
  });
  it('removes the named device', async () => {
    const r = await revokeOtherDevice(LOST);
    expect(r).toMatchObject({ ok: true, data: 'revoke-sig' });
    expect(s.revoked).toEqual([LOST]);
  });
});
