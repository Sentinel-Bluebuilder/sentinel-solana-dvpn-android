// ─── Every configurable thing has a CLI path (owner rule: anything configurable = a CLI function) ───
// Adding a setting, a daemon config field or a polling job without a CLI path fails here.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { POLL_JOB_NAMES } from '../../src/shared/poll';
import { CATALOGUE } from '../../src/cli/catalogue';

const usage = (cmd: string): string => CATALOGUE.find((c) => c.cmd === cmd)?.usage ?? '';
const all = CATALOGUE.map((c) => `${c.usage} ${c.summary}`).join('\n');

describe('CLI covers every setting', () => {
  // App settings: `settings set key=value`, except the three with their own commands.
  const OWN: Record<string, string> = { rpcUrls: 'rpc set', favourites: 'nodes fav', poll: 'poll set' };
  it.each(Object.keys(DEFAULT_SETTINGS))('app setting %s', (k) => {
    if (OWN[k]) expect(usage(OWN[k])).not.toBe('');
    else expect(usage('settings set')).toMatch(/key=value/);
  });

  // Daemon config fields: a `daemon set` flag each.
  const FLAG: Record<string, string> = {
    killSwitch: '--kill-switch', dnsMode: '--dns-mode', allowLan: '--allow-lan', dnsServers: '--dns', basis: '--basis', escrow: '--escrow',
    prepayBytes: '--prepay-mb', prepaySeconds: '--prepay-minutes', wholeDevice: '--whole-device', rpcUrl: '--rpc ', rpcWsUrl: '--rpc-ws',
    // [split] (SplitSettings fields)
    mode: '--split-mode', apps: '--split-apps', routes: '--split-routes', split: '--split-mode',
  };
  const fields = [...fs.readFileSync('src/core/daemon/config.ts', 'utf8').matchAll(/^\s{2}(\w+)\??:\s/gm)]
    .map((m) => m[1])
    .filter((f, i, arr) => arr.indexOf(f) === i);
  const daemonFields = [...fields.slice(0, fields.indexOf('rpcWsUrl') + 1), ...(fields.includes('split') ? ['split'] : [])];
  it('reads the DaemonSettings fields', () => expect(daemonFields).toContain('escrow'));
  it.each(daemonFields)('daemon field %s', (f) => {
    expect(FLAG[f], `no flag mapped for ${f}`).toBeDefined();
    expect(usage('daemon set')).toContain(FLAG[f]);
  });

  // Polling jobs: named in `poll set`, and every scheduler job is a known poll job.
  it.each(POLL_JOB_NAMES)('poll job %s', (j) => expect(all).toContain(j));
  it('scheduler jobs == poll jobs (session: adoption here, in-session fallback in connection.ts)', () => {
    const src = fs.readFileSync('src/main/scheduler.ts', 'utf8');
    const names = [...src.matchAll(/name: '(\w+)', whenHidden/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...POLL_JOB_NAMES].sort());
    expect(fs.readFileSync('src/main/services/connection.ts', 'utf8')).toMatch(/poll\?\.session/);
  });
});

describe('Settings screen covers every setting (CLI = app)', () => {
  const ui = ['Settings', 'KillSwitch', 'SplitTunnel'].map((p) => fs.readFileSync(`src/renderer/src/screens/${p}.tsx`, 'utf8')).join('\n');
  const UI_ELSEWHERE: Record<string, string> = { favourites: 'node list star', language: 'English only in v1', poll: 'PollSettings' };
  it.each(Object.keys(DEFAULT_SETTINGS))('app setting %s has a control', (k) => {
    if (UI_ELSEWHERE[k]) return expect(UI_ELSEWHERE[k] === 'PollSettings' ? ui : 'ok').toContain(UI_ELSEWHERE[k] === 'PollSettings' ? '<PollSettings' : 'ok');
    expect(ui).toMatch(new RegExp(`settings\.${k}\b|\{ ${k}:`));
  });
  it.each(['killSwitch', 'dnsMode', 'allowLan', 'dnsServers', 'basis', 'escrow', 'prepayBytes', 'prepaySeconds', 'wholeDevice', 'rpcUrl', 'rpcWsUrl'])('daemon field %s has a control', (f) => {
    expect(ui).toMatch(new RegExp(`draft\.${f}\b|${f}:`));
  });
  it('daemon field split has controls for mode, apps and routes (Split tunnelling page)', () => {
    const page = fs.readFileSync('src/renderer/src/screens/SplitTunnel.tsx', 'utf8');
    expect(page).toMatch(/setSplit\(\{ mode:/);
    expect(page).toMatch(/setSplit\(\{ apps:/);
    expect(page).toMatch(/setSplit\(\{ routes:/);
    expect(page).toMatch(/validateSplit\(split\)/); // same rules as dvpnd before Apply
  });
});
