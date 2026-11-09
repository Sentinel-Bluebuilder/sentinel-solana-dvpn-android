// ─── Unknown flags are refused (the macOS app rig 2: `daemon set --dns-preset quad9 --yes` said "Applied and
// restarted" and changed nothing: the real flag is --dns; port of Mac 0790fc2) ───
import { describe, expect, it } from 'vitest';
import { CATALOGUE, entryFor, unknownFlags } from '../../src/cli/catalogue';
import { parseArgs } from '../../src/cli/args';

const unknown = (argv: string): string[] => { const a = parseArgs(argv.split(' ')); return unknownFlags(a._, a.flags); };

describe('unknown flags', () => {
  it('a typo in a flag name is caught, not ignored', () => {
    expect(unknown('daemon set --dns-preset quad9 --yes')).toEqual(['dns-preset']);
    expect(unknown('connect NodeA --unit 2 --yes')).toEqual(['unit']);
  });
  it('the flags a command documents, and the global ones, pass', () => {
    expect(unknown('daemon set --dns quad9 --kill-switch on --yes')).toEqual([]);
    expect(unknown('connect NodeA --units 2 --basis per_gb --yes --json')).toEqual([]);
    expect(unknown('status --json --verbose --keyfile C:\\x.json')).toEqual([]);
    expect(unknown('device register --home C:\\ProgramData\\dvpnd\\client')).toEqual([]);
    expect(unknown('test run --online --max-nodes 3 --max-spend 5 --yes')).toEqual([]);
  });
  it('a variant entry adds its flags to the command (connect --follow)', () => {
    expect(unknown('connect NodeA --switch --follow --yes')).toEqual([]);
  });
  it('the longest command phrase wins (daemon set, not daemon)', () => {
    expect(entryFor('daemon set')?.cmd).toBe('daemon set');
    expect(entryFor('settle run')?.cmd).toBe('settle run');
  });
  it('a command not in the catalogue is left to its own usage message', () => {
    expect(unknown('nosuch --x 1')).toEqual([]);
  });
  it('every usage line parses to at least its own flags (no entry refuses what it documents)', () => {
    for (const e of CATALOGUE) {
      const flags = (e.usage.match(/--[a-z0-9-]+/g) ?? []).map((f) => f.slice(2));
      const fl: Record<string, true> = {}; for (const f of flags) fl[f] = true;
      expect(unknownFlags(e.cmd.split(' ').filter((w) => !w.startsWith('--')), fl), e.cmd).toEqual([]);
    }
  });
});
