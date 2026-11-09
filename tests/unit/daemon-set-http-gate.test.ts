// ─── Q0478 (= Mac Q0468): with an http RPC gate stored, `daemon set` still changes other settings ───
// Every write re-checked the stored RPC against https and died with "RPC url must use https://", so the
// kill switch never persisted. The https rule now holds only for an RPC being set.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GATE = 'http://127.0.0.1:18899/c/pcjwPAbiA1CUVb48vVb98iXy';
const applied: unknown[] = [];
vi.mock('../../src/main/daemon/settings', () => ({
  getDaemonSettings: () => ({
    readable: true,
    settings: {
      killSwitch: 'off', allowLan: false, dnsServers: ['10.8.0.1'], dnsMode: 'vpn', basis: 'per_gb', escrow: '1000000',
      prepayBytes: '0', prepaySeconds: '0', rpcUrl: GATE, rpcWsUrl: GATE.replace(/^http/, 'ws'),
    },
  }),
  applyDaemonSettings: async (s: unknown) => { applied.push(s); return { ok: true, data: null }; },
}));

const { daemonCmd } = await import('../../src/cli/daemon-cmd');
const { parseArgs, UsageError } = await import('../../src/cli/args');

const run = (argv: string[]): Promise<void> =>
  daemonCmd(parseArgs(['daemon', ...argv]), { json: false, print: () => undefined });

describe('daemon set with an http RPC gate stored (Q0478)', () => {
  beforeEach(() => { applied.length = 0; process.env.DVPN_PLATFORM = 'android'; });

  it('a kill switch change goes through and carries the gate unchanged', async () => {
    await run(['set', '--kill-switch', 'persist', '--yes']);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ killSwitch: 'persist', rpcUrl: GATE });
  });

  it('setting a new plain-http RPC is still refused', async () => {
    await expect(run(['set', '--rpc', 'http://rpc.example.org/', '--yes'])).rejects.toBeInstanceOf(UsageError);
    expect(applied).toHaveLength(0);
  });
});
