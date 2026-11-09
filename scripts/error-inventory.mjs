// ─── error-inventory — every user-facing error / warning string in the app (E1) ───
// Scans src/ for the places a message reaches a person: Result failures (`error:` / fail()),
// thrown Error / UsageError / ConfigError / FlagError, toasts, Banners, copy tables
// (message: …), and `→ action` labels. Writes docs/ERROR-INVENTORY.md and, with --json,
// prints the rows (used by the E5 standards test).
//   node scripts/error-inventory.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC = path.join(ROOT, 'src');

const KINDS = [
  ['throw', /throw new (?:Error|UsageError|ConfigError|FlagError|AmountError)\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g],
  ['result', /\berror:\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g],
  ['fail', /\bfail\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g],
  ['toast', /toast\(\s*'(?:error|warn|info|success)',\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g],
  ['copy', /\bmessage:\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g],
  // props may hold JSX and arrows (`action={<button onClick={() => …}>…</button>}`): skip to the
  // Banner's own `>` by matching balanced-enough `{…}` props instead of stopping at the first `>`
  // returned sentences (refusal helpers like fundingBlocker, dnsProbeProblem): a capital first and
  // a full stop / question mark last, so code-ish returns ('ok', keys, paths) stay out
  ['return', /\breturn\s+(`[A-Z](?:[^`\\]|\\.)*[.?]`|'[A-Z](?:[^'\\]|\\.)*[.?]'|"[A-Z](?:[^"\\]|\\.)*[.?]")/g],
  ['banner', /<Banner(?:\s+\w+=(?:"[^"]*"|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}))*\s*>([^<{]{8,})</g],
];

function walk(dir, out = []) {
  // Sorted: NTFS lists names in order, ext4 in hash order; the doc must come out the same on both.
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const unquote = (s) => s.replace(/^[`'"]|[`'"]$/g, '').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();

export function inventory() {
  const rows = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const [kind, re] of KINDS) {
      for (const m of text.matchAll(re)) {
        const line = text.slice(0, m.index).split('\n').length;
        const after = text.slice(m.index, m.index + 400);
        const action = /action:\s*'([^']+)'/.exec(after)?.[1] ?? null;
        // `// copy:internal` on the line = a programmer invariant no person sees; listed, not checked
        const internal = text.split('\n')[line - 1].includes('copy:internal');
        if (!unquote(m[1])) continue;  // a Banner whose child is an expression ({t('…')}), not text
        rows.push({ file: rel, line, kind, text: unquote(m[1]), action, layer: rel.split('/')[1], internal });
      }
    }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Run as a script only: tests import inventory() without rewriting the doc.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const rows = isMain ? inventory() : [];
if (!isMain) {
  // imported (tests/unit/error-standards.test.ts)
} else if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
} else {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
  const byKind = rows.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
  const md = [
    '# Error inventory (generated — `node scripts/error-inventory.mjs`)',
    '',
    'Every user-facing error, warning and refusal string in `src/`, found by pattern (thrown errors,',
    'Result `error:`, `fail()`, toasts, Banners, copy tables). Input to E3 (`ERROR-STANDARDS.md`);',
    'do not edit by hand, re-run the script.',
    '',
    `Total ${rows.length}: ` + Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', '),
    '',
    '| Where | Kind | Text | Action |',
    '|---|---|---|---|',
    ...rows.map((r) => `| \`${r.file}:${r.line}\` | ${r.kind} | ${esc(r.text)} | ${esc(r.action ?? '')} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs', 'ERROR-INVENTORY.md'), md);
  console.log(`docs/ERROR-INVENTORY.md: ${rows.length} strings (${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')})`);
}
