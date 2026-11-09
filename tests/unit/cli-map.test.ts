// Every app function (IPC channel) must exist in the CLI. A new channel without a
// CLI command — or a map entry naming a command the CLI doesn't have — fails here.
import { describe, expect, it } from 'vitest';
import { TIERS } from '../../src/shared/ipc';
import { CLI_FOR_IPC, CLI_VARIANTS } from '../../src/cli/ipc-map';
import { COMMANDS } from '../../src/cli/commands';

function exists(cli: string): boolean {
  const [cmd, sub] = cli.split(' ');
  const c = COMMANDS[cmd];
  if (!c) return false;
  if (!sub || sub.startsWith('--')) return true;
  // subcommands are listed in the help text, separated by " | " or at the start
  return new RegExp(`(^|\\| )${sub}( |$|\\[|<)`).test(c.help) || c.help.split(' | ').some((h) => h.startsWith(sub));
}

describe('cli covers every app function', () => {
  it('has an entry for every IPC channel', () => {
    expect(Object.keys(CLI_FOR_IPC).sort()).toEqual(Object.keys(TIERS).sort());
  });
  it('every mapped command exists in the CLI', () => {
    const missing = Object.entries(CLI_FOR_IPC).filter(([, v]) => typeof v === 'string' && !exists(v)).map(([k, v]) => `${k} -> ${v}`);
    const missingVariants = CLI_VARIANTS.filter((v) => !exists(v.cli)).map((v) => `${v.channel} (${v.variant}) -> ${v.cli}`);
    expect([...missing, ...missingVariants]).toEqual([]);
  });
  it('only UI plumbing is CLI-less', () => {
    const none = Object.entries(CLI_FOR_IPC).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
    // apps:pick is a file dialog; the CLI takes the .exe path in `daemon set --split-apps`.
    expect(none.sort()).toEqual(['app:copy', 'app:open-external', 'apps:pick', 'cli:powershell', 'cli:run']);
  });
  it('a negative control fails the existence check', () => {
    expect(exists('wallet teleport')).toBe(false);
    expect(exists('nosuchcommand')).toBe(false);
  });
});

// ─── The catalogue (help, in-app CLI screen, docs/CLI.md) stays complete ───
import fs from 'node:fs';
import { CATALOGUE, entryFor, catalogueMarkdown } from '../../src/cli/catalogue';

describe('cli catalogue', () => {
  it('describes every top-level command', () => {
    const described = new Set(CATALOGUE.map((e) => e.cmd.split(' ')[0]));
    expect(Object.keys(COMMANDS).filter((k) => !described.has(k))).toEqual([]);
  });
  it('names only commands the CLI has', () => {
    expect(CATALOGUE.filter((e) => !exists(e.cmd)).map((e) => e.cmd)).toEqual([]);
  });
  it('has an entry for every app function', () => {
    const lines = [...Object.values(CLI_FOR_IPC).filter((v): v is string => typeof v === 'string'), ...CLI_VARIANTS.map((v) => v.cli)];
    expect(lines.filter((l) => !entryFor(l)).sort()).toEqual([]);
  });
  it('every spend usage line carries --yes', () => {
    expect(CATALOGUE.filter((e) => e.confirm && !e.usage.includes('--yes') && !e.usage.includes('…')).map((e) => e.cmd)).toEqual([]);
  });
  it('docs/CLI.md is up to date (npm run docs:cli)', () => {
    expect(fs.readFileSync('docs/CLI.md', 'utf8').replace(/\r\n/g, '\n')).toContain(catalogueMarkdown());
  });
  it('negative control: an unknown line has no entry', () => expect(entryFor('teleport now')).toBeNull());
});
