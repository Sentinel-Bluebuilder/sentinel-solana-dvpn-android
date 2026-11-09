// ─── `daemon set`: bad values never reach the apply step; Android copy has no admin prompt ───
import { describe, it, expect, vi, beforeEach } from 'vitest';

const applied: unknown[] = [];
vi.mock('../../src/main/daemon/settings', () => ({
  getDaemonSettings: () => ({
    readable: true,
    settings: {
      killSwitch: 'off', allowLan: false, dnsServers: ['10.8.0.1'], dnsMode: 'vpn', basis: 'per_gb', escrow: '1000000',
      prepayBytes: '0', prepaySeconds: '0', rpcUrl: 'https://api.devnet.solana.com', rpcWsUrl: 'wss://api.devnet.solana.com',
    },
  }),
  applyDaemonSettings: async (s: unknown) => { applied.push(s); return { ok: true, data: null }; },
}));

const { daemonCmd } = await import('../../src/cli/daemon-cmd');
const { parseArgs, UsageError } = await import('../../src/cli/args');
const { NeedsConfirm } = await import('../../src/cli/commands');

const run = async (argv: string[]): Promise<string[]> => {
  const lines: string[] = [];
  await daemonCmd(parseArgs(['daemon', ...argv]), { json: false, print: (h: string) => { lines.push(h); } });
  return lines;
};

describe('daemon set', () => {
  beforeEach(() => { applied.length = 0; process.env.DVPN_PLATFORM = 'android'; });

  it('refuses --allow-lan values other than true / false (used to become false silently)', async () => {
    for (const v of ['yes', '1', 'TRUE', 'on']) {
      await expect(run(['set', '--allow-lan', v, '--yes'])).rejects.toBeInstanceOf(UsageError);
    }
    expect(applied).toHaveLength(0);
  });

  it('applies --allow-lan true', async () => {
    await run(['set', '--allow-lan', 'true', '--yes']);
    expect(applied).toHaveLength(1);
    expect((applied[0] as { allowLan: boolean }).allowLan).toBe(true);
  });

  it('asks before applying, without promising an admin prompt on Android', async () => {
    const lines: string[] = [];
    await expect(daemonCmd(parseArgs(['daemon', 'set', '--kill-switch', 'on']), { json: false, print: (h: string) => { lines.push(h); } })).rejects.toBeInstanceOf(NeedsConfirm);
    expect(lines.join('\n')).toMatch(/restart the VPN engine/);
    expect(lines.join('\n')).not.toMatch(/administrator/);
    expect(applied).toHaveLength(0);
  });
});
