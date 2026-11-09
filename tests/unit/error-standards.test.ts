// ─── Error-copy standards (docs/ERROR-STANDARDS.md, the [auto] rules) ───
// Every user-facing string found by scripts/error-inventory.mjs goes through checkCopy.
// CLI usage lines (a command synopsis or a flag message thrown as a usage error) are not prose:
// they follow the CLI's usage form, so only the raw-internals and tone rules apply to them.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { inventory } from '../../scripts/error-inventory.mjs';
import { checkCopy, type CopyIssue } from '../../src/core/app/copy-rules';

interface Row { file: string; line: number; kind: string; text: string; action: string | null; internal: boolean }

const all = (inventory() as Row[]).filter((r) => r.text.trim());
// `// copy:internal` = a programmer invariant no person sees (guards, IPC shape checks).
const rows = all.filter((r) => !r.internal);
const isCli = (r: Row) => r.file.startsWith('src/cli/');
// "connect <node> [--basis] …", "--units must be …" (FlagError, any file), "unknown: wallet X"
const isUsage = (r: Row) => r.kind === 'throw' && (/^--/.test(r.text) || (isCli(r) && /^(unknown:|[a-z][\w-]*( [\w$<[{-]|$))/.test(r.text)));
const limitFor = (r: Row) => (['toast', 'banner'].includes(r.kind) || isCli(r) ? 180 : 300);
// The Settings screen labels its sections "Solana RPC" and "VPN service → RPC", so a message that
// sends the person there may use the same word (glossary rule 10 beats the jargon list here).
const namesSetting = (r: Row, i: CopyIssue) => i.rule === '1-jargon' && i.detail === '"RPC"' && /Settings/.test(r.text);
// A quoted CLI command ("daemon set --dns cloudflare --yes") is something to type, not prose: the
// glossary lets the CLI name daemon/dvpnd in commands to run.
const inCommandOnly = (r: Row, i: CopyIssue) => i.rule === '1-jargon' && !checkCopy(r.text.replace(/"[a-z][\w-]* [^"]*--[^"]*"/g, '"X"'), { surface: 'ui', limit: 1e6 }).some((j) => j.detail === i.detail);

function issues(r: Row): CopyIssue[] {
  const found = checkCopy(r.text, { surface: isCli(r) ? 'cli' : 'ui', limit: limitFor(r) }).filter((i) => !namesSetting(r, i) && !inCommandOnly(r, i));
  return isUsage(r) ? found.filter((i) => /^(5|6)-/.test(i.rule)) : found;
}

describe('error-copy standards', () => {
  it('the inventory finds the app strings', () => {
    expect(rows.length).toBeGreaterThan(200);  // positive control: the scanner still sees src/
    expect(all.length - rows.length).toBeLessThan(30);  // internal is the exception, not an escape hatch
  });
  it('checkCopy catches a bad message (negative control)', () => {
    const bad = checkCopy('invalid', { surface: 'ui' }).map((i) => i.rule);
    expect(bad).toContain('9-capital');
    expect(checkCopy('Error: RPC failed!', { surface: 'ui' }).map((i) => i.rule)).toEqual(expect.arrayContaining(['5-raw', '1-jargon', '6-exclamation']));
  });
  it('every user-facing string meets the [auto] rules', () => {
    const bad = rows.flatMap((r) => issues(r).map((i) => `${r.file}:${r.line} [${i.rule}] ${i.detail} :: ${r.text.slice(0, 120)}`));
    expect(bad).toEqual([]);
  });
});
