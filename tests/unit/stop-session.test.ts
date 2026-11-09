// ─── Disconnect after dvpnd reconnected under a new session id ───
// Live 2026-10-21 (kernel-7 VM): the node stopped answering, dvpnd reconnected as a new session,
// `disconnect` sent the old id, got "not found" and left the tunnel up.
import { describe, it, expect, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';

vi.mock('../../src/main/logger', () => ({ log: { warn: () => undefined, info: () => undefined, error: () => undefined } }));
vi.mock('../../src/main/daemon/manager', () => ({ daemon: vi.fn() }));
const { DaemonError } = await import('../../src/core/daemon/client');
const { stopLiveOrCurrent } = await import('../../src/main/services/stop-session');

const notFound = (): Error => new DaemonError(Object.assign(new Error('no active session'), { code: grpc.status.NOT_FOUND, details: 'no active session' }) as grpc.ServiceError, 'StopSession');
const ok = { session: null, killSwitchReleased: true, dnsRevertFailed: false };

describe('stopLiveOrCurrent', () => {
  it('stops by id when the id is current', async () => {
    const stop = vi.fn(async () => ok);
    expect(await stopLiveOrCurrent('A', { stopSession: stop })).toBe(ok);
    expect(stop.mock.calls).toEqual([['A', {}]]);
  });
  it('id gone (dvpnd reconnected): stops whatever runs now', async () => {
    const stop = vi.fn(async (id: string) => { if (id) throw notFound(); return ok; });
    expect(await stopLiveOrCurrent('A', { stopSession: stop })).toBe(ok);
    expect(stop.mock.calls).toEqual([['A', {}], ['', {}]]);
  });
  it('nothing runs at all: disconnected, not an error', async () => {
    const stop = vi.fn(async () => { throw notFound(); });
    expect(await stopLiveOrCurrent('A', { stopSession: stop })).toEqual({ session: null, killSwitchReleased: false, dnsRevertFailed: false });
  });
  it('other daemon errors still fail', async () => {
    const stop = vi.fn(async () => { throw new Error('socket closed'); });
    await expect(stopLiveOrCurrent('A', { stopSession: stop })).rejects.toThrow('socket closed');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('stopLiveOrCurrent keepKillSwitch (gap #67)', () => {
  it('passes the switch flag to dvpnd on both tries', async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ session: null, killSwitchReleased: false, dnsRevertFailed: false });
    await stopLiveOrCurrent('A', { stopSession: stop }, { keepKillSwitch: true });
    expect(stop.mock.calls).toEqual([['A', { keepKillSwitch: true }], ['', { keepKillSwitch: true }]]);
  });
});
