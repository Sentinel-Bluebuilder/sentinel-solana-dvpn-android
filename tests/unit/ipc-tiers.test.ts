// Proves the tier map and the registered handlers are the same set (M5.2 #1):
// a handler without a tier, or a tier without a handler, fails here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {}, clipboard: {}, dialog: {}, BrowserWindow: { getFocusedWindow: () => null }, app: {} }));

describe('ipc tiers', () => {
  it('every handler has a tier and every tier has a handler', async () => {
    const { HANDLERS } = await import('../../src/main/ipc');
    const { TIERS } = await import('../../src/shared/ipc');
    expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(TIERS).sort());
  });
  it('anything that moves funds or signs is spend tier', async () => {
    const { IPC, TIERS } = await import('../../src/shared/ipc');
    for (const c of [IPC.CONNECT, IPC.DEVICE_SETUP, IPC.SUBSCRIBE, IPC.SETTLE_RUN, IPC.WITHDRAW, IPC.SEND]) expect(TIERS[c]).toBe('spend');
    for (const c of [IPC.DAEMON_SETTINGS_APPLY, IPC.DAEMON_INIT, IPC.RESTORE_NETWORK]) expect(TIERS[c]).toBe('privileged');
  });
  it('spend handlers refuse a payload without confirmed: true', async () => {
    const electron = await import('electron');
    const { registerIpc } = await import('../../src/main/ipc');
    const { IPC } = await import('../../src/shared/ipc');
    const { setHost } = await import('../../src/main/host');
    setHost({ name: 'cli', resourcesDir: '.', dataDir: '.', emit: () => undefined, keyStore: { kind: 'memory', exists: () => false, load: () => null, save: () => undefined, remove: () => undefined } });
    const { initStore } = await import('../../src/main/store');
    initStore((await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'dvpn-ipc-')));
    registerIpc();
    const handle = electron.ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const send = handle.mock.calls.find((c) => c[0] === IPC.SEND)![1] as (e: unknown, p: unknown) => Promise<{ ok: boolean; code?: string }>;
    expect(await send({}, { to: 'x' })).toMatchObject({ ok: false, code: 'not-confirmed' });
  });
});
