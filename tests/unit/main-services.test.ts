import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { setHost } from '../../src/main/host';
import { initStore } from '../../src/main/store';
import { setSystemProxy, clearSystemProxy, systemProxyActive, setProxyRunner, setSocksCheck, savedState, parseState, type ProxyState } from '../../src/main/system/proxy';
import { elevatedArgLine, elevatedOuterCommand } from '../../src/main/system/elevate';
import { sanitize } from '../../src/main/system/settings';
import { historyCsv } from '../../src/main/services/history';
import { redactUrls, redact } from '../../src/main/logger';
import { parseArgs } from '../../src/cli/args';
import { nodeApiOverride } from '../../src/core/nodes/discovery';
import { providerApiOverride } from '../../src/core/plans/plans';
import { closeChannel } from '../../src/core/chain/builders';
import { pda } from '../../src/core/chain/program';
import { DEFAULT_SETTINGS } from '../../src/shared/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvpn-unit-'));
beforeAll(() => {
  setHost({ name: 'cli', resourcesDir: dir, dataDir: dir, emit: () => undefined, keyStore: { kind: 'memory', exists: () => false, load: () => null, save: () => undefined, remove: () => undefined } });
  initStore(dir);
});

// ─── System proxy: never touches the real registry here ───
describe('system proxy', () => {
  // A user with auto-detect + PAC + a manual corp proxy: all four values must come back.
  const userState: ProxyState = { flags: 1 | 2 | 4 | 8, server: 'corp:8080', bypass: '*.corp;<local>', pac: 'http://wpad/proxy.pac' };
  const fake = (start: ProxyState) => {
    let cur = { ...start };
    const sets: ProxyState[] = [];
    setProxyRunner({ query: async () => ({ ...cur }), set: async (s) => { sets.push(s); cur = { ...s }; return { ...cur }; } });
    return { now: () => cur, sets, change: (s: ProxyState) => { cur = s; } };
  };
  it('saves the user proxy first, restores all of it exactly, and only undoes its own value', async () => {
    setSocksCheck(async () => ({ ok: true, reason: 'stub' }));
    const f = fake(userState);
    await setSystemProxy('127.0.0.1:1080');
    expect(f.now()).toEqual({ flags: 3, server: 'socks=127.0.0.1:1080', bypass: '<local>', pac: '' });
    expect(systemProxyActive()).toBe(true);
    await clearSystemProxy();
    expect(f.now()).toEqual(userState);
    expect(systemProxyActive()).toBe(false);
  });
  it('leaves a proxy the user changed meanwhile alone', async () => {
    const f = fake(userState);
    await setSystemProxy('127.0.0.1:1080');
    const theirs = { flags: 3, server: 'other:3128', bypass: '', pac: '' };
    f.change(theirs);
    await clearSystemProxy();
    expect(f.now()).toEqual(theirs);
    expect(systemProxyActive()).toBe(false);
  });
  it('restores an old registry-form backup', () => {
    expect(savedState({ proxyEnable: 1, proxyServer: 'corp:8080', ours: 'socks=127.0.0.1:1080' })).toEqual({ flags: 3, server: 'corp:8080', bypass: '', pac: '' });
    expect(savedState({ proxyEnable: 0, proxyServer: null, ours: 'x' }).flags).toBe(1);
  });
  it('fails when Windows does not take the setting', async () => {
    setProxyRunner({ query: async () => ({ ...userState }), set: async () => ({ ...userState }) });
    await expect(setSystemProxy('127.0.0.1:1080')).rejects.toThrow(/did not accept/);
    fake(userState);
    await clearSystemProxy();
  });
  it('reads the helper output', () => {
    expect(parseState('WARNING: x\r\n{"flags":9,"server":"","bypass":"","pac":"http://p"}\r\n')).toEqual({ flags: 9, server: '', bypass: '', pac: 'http://p' });
    expect(() => parseState('boom')).toThrow(/no state/);
  });
  it('refuses a non-loopback endpoint', async () => {
    await expect(setSystemProxy('10.0.0.5:1080')).rejects.toThrow(/non-loopback/);
  });
});

describe('elevated command line', () => {
  it('quotes paths with spaces and rejects injection', () => {
    const line = elevatedArgLine('C:\\Program Files\\Devnet dVPN\\resources\\scripts\\setup-daemon.ps1', { Owner: '11111111111111111111111111111111' });
    expect(line).toContain('-File "C:\\Program Files\\Devnet dVPN\\resources\\scripts\\setup-daemon.ps1"');
    expect(() => elevatedArgLine('x.ps1', { Owner: "a'; Remove-Item C:\\ -Recurse" })).toThrow(/unsafe/);
    expect(() => elevatedArgLine('x.ps1', { 'Bad-Name': 'a' })).toThrow(/parameter/);
  });

  it('prompts (RunAs) only when the caller is not already an administrator', () => {
    const outer = elevatedOuterCommand(elevatedArgLine('C:\\a b\\s.ps1', { Dir: 'C:\\x' }));
    const [adminBranch, userBranch] = outer.split('else');
    expect(adminBranch).toContain('IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    expect(adminBranch).not.toContain('RunAs');
    expect(userBranch).toContain('-Verb RunAs');
    expect(outer).toContain(`$a = '-NoProfile -ExecutionPolicy Bypass -File "C:\\a b\\s.ps1" -Dir "C:\\x"'`);
  });
});

describe('settings allow-list', () => {
  it('drops unknown keys and invalid values, keeps valid ones', () => {
    const s = sanitize({ rpcUrls: ['http://evil.example', 'https://ok.example'], defaultGb: 3, theme: 'dark', bogus: 1 } as never);
    expect(s.rpcUrls).toEqual(['https://ok.example']);
    expect(s.defaultGb).toBe(DEFAULT_SETTINGS.defaultGb);
    expect(s.theme).toBe('dark');
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe('history csv', () => {
  it('escapes commas and quotes', () => {
    const csv = historyCsv([{ id: 'a', node: 'n', country: 'Korea, South', service: 'wg', startedAt: 1, endedAt: 2, rxBytes: '1', txBytes: '2', spent: '3', channel: 'c', closeReason: 'say "hi"' }]);
    expect(csv.split('\n')[1]).toBe('a,n,"Korea, South",wg,1,2,1,2,3,c,"say ""hi"""');
  });
});

describe('redaction', () => {
  it('strips query strings from http and ws URLs, and secret keys from objects', () => {
    expect(redactUrls('url = wss://rpc.example/?api-key=SECRET')).toBe('url = wss://rpc.example/?<redacted>');
    // user:password@ is a credential too; an @ later in the path is not userinfo (the macOS app fuzz)
    expect(redactUrls('unknown job "https://u:p@127.0.0.1:9/?api-key=S"')).toBe('unknown job "https://<redacted>@127.0.0.1:9/?<redacted>"');
    expect(redactUrls('see https://host/a@b and wss://k@rpc.x/ws')).toBe('see https://host/a@b and wss://<redacted>@rpc.x/ws');
    expect(JSON.stringify(redact({ mnemonic: 'a b c', url: 'https://x/?k=1' }))).toBe('{"mnemonic":"[redacted]","url":"https://x/?<redacted>"}');
  });
});

describe('cli args', () => {
  it('parses positionals, flags, booleans and -y', () => {
    const a = parseArgs(['connect', 'N', '--units', '2', '--yes', '--basis=per_hour', '-y', '--json']);
    expect(a._).toEqual(['connect', 'N']);
    expect(a.flags).toEqual({ units: '2', yes: true, basis: 'per_hour', json: true });
  });
});

describe('test-rig overrides', () => {
  it('match only the named account', () => {
    expect(nodeApiOverride('A', 'A=https://127.0.0.1:1,B=https://x:2')).toBe('https://127.0.0.1:1');
    expect(nodeApiOverride('C', 'A=https://127.0.0.1:1')).toBeNull();
    expect(providerApiOverride('P', 'P=https://127.0.0.1:19443/')).toBe('https://127.0.0.1:19443');
  });
});

// ─── close_channel grant (grants program, 2026-10-21) ───
describe('close_channel grant', () => {
  const owner = Keypair.generate().publicKey;
  const device = Keypair.generate().publicKey;
  const ch = { address: Keypair.generate().publicKey, owner, opener: device, node: Keypair.generate().publicKey, rentPayer: device, mode: 1 };
  const keysOf = (ix: { keys: Array<{ pubkey: PublicKey }> }): string[] => ix.keys.map((k) => k.pubkey.toBase58());
  it('owner-signed close of a device channel passes no grant', async () => {
    const ix = await closeChannel({ signer: owner, ch });
    expect(keysOf(ix)).not.toContain(pda.grant(owner, device).toBase58());
  });
  it('device-signed stream close passes the [owner, signer, default] grant', async () => {
    const ix = await closeChannel({ signer: device, ch });
    expect(keysOf(ix)).toContain(pda.grant(owner, device).toBase58());
  });
  it('voucher close passes no grant (anyone may close after the grace)', async () => {
    const ix = await closeChannel({ signer: device, ch: { ...ch, mode: 0 } });
    expect(keysOf(ix)).not.toContain(pda.grant(owner, device).toBase58());
  });
});

// ─── Display formatting shared by renderer, CLI and main ───
describe('format', () => {
  it('formats balances, bytes, durations and countdowns', async () => {
    const f = await import('../../src/shared/format');
    expect(f.formatTdvpn('946397711839')).toBe('946,397.71');
    expect(f.formatTdvpn('1994000')).toBe('1.994');
    expect(f.formatTdvpn('999123456')).toBe('999.123456');
    expect(f.formatBytes(3_200_000)).toBe('3.2 MB');
    expect(f.formatDuration(3725)).toBe('1:02:05');
    expect(f.formatCountdown(5700)).toBe('1 h 35 min');
  });
});

describe('quick pick', () => {
  it('prefers favourites, then preferred country, then lowest latency; online only', async () => {
    const { pickQuickNode } = await import('../../src/shared/quick-pick');
    const n = (address: string, cc: string, ms: number | null, fav = false) => ({ address, countryCode: cc, favourite: fav, probe: ms === null ? { ok: false } : { ok: true, latencyMs: ms } }) as never;
    const list = [n('A', 'DE', 80), n('B', 'US', 20), n('C', 'DE', 40), n('D', 'IN', 5, true), n('E', 'US', null, true)];
    expect(pickQuickNode(list, null)!.address).toBe('D');
    expect(pickQuickNode(list.slice(0, 3), 'DE')!.address).toBe('C');
    expect(pickQuickNode(list.slice(0, 3), null)!.address).toBe('B');
    expect(pickQuickNode([n('E', 'US', null)], null)).toBeNull();
  });
});

const userStateSafety = { flags: 1, server: '', bypass: '', pac: '' };
describe('system proxy safety', () => {
  it('a dead SOCKS endpoint changes nothing (the internet stays up)', async () => {
    const calls: string[][] = [];
    setProxyRunner({ query: async () => { calls.push(['query']); return userStateSafety; }, set: async (s) => { calls.push(['set']); return s; } });
    setSocksCheck(async () => ({ ok: false, reason: 'ECONNREFUSED' }));
    await expect(setSystemProxy('127.0.0.1:1080')).rejects.toThrow(/not answering.*Nothing was changed/);
    expect(calls).toEqual([]);
  });
});
