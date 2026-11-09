// ─── docs/UI-CONTROLS.md: every control → IPC → main handler → CLI → tests (button audit, U3) ───
// Generated part: two tables built from the code (renderer controls, src/shared/ipc.ts TIERS,
// src/main/ipc.ts handlers, src/cli/ipc-map.ts, and which test scripts run each CLI command).
// Hand part: everything between the TRACE markers is kept as written (the by-hand traces).
//   node scripts/ui-controls-doc.mjs          write the doc
//   node scripts/ui-controls-doc.mjs --check  exit 1 when the doc is stale (unit test uses this too)
import fs from 'node:fs';
import path from 'node:path';
import { scan } from './ui-controls-inventory.mjs';

const DOC = 'docs/UI-CONTROLS.md';
const START = '<!-- TRACE:START (hand-written, kept on regenerate) -->';
const END = '<!-- TRACE:END -->';

function read(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

/** CONST → 'chan:name' from src/shared/ipc.ts, plus tiers. */
function channels() {
  const src = read('src/shared/ipc.ts');
  const names = Object.fromEntries([...src.matchAll(/^\s{2}([A-Z_]+): '([a-z:-]+)',/gm)].map((m) => [m[1], m[2]]));
  const tiers = Object.fromEntries([...src.matchAll(/\[IPC\.([A-Z_]+)\]: '(\w+)'/g)].map((m) => [m[1], m[2]]));
  return Object.keys(tiers).map((k) => ({ key: k, chan: names[k], tier: tiers[k] }));
}

/** CONST → CLI command or { none } from src/cli/ipc-map.ts. */
function cliMap() {
  const src = read('src/cli/ipc-map.ts');
  const out = {};
  for (const m of src.matchAll(/\[IPC\.([A-Z_]+)\]: (?:'([^']+)'|\{ none: '([^']+)' \})/g)) out[m[1]] ??= m[2] ? { cli: m[2] } : { none: m[3] };
  const variants = {};
  for (const m of src.matchAll(/channel: IPC\.([A-Z_]+), variant: "?([^,]+?)"?, cli: '([^']+)'/g)) (variants[m[1]] ??= []).push(m[3]);
  return { out, variants };
}

/** CONST → main handler line + the functions it calls first (service entry points). */
function handlers() {
  const src = read('src/main/ipc.ts');
  const lines = src.split('\n');
  const out = {};
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[IPC\.([A-Z_]+)\]:/);
    if (!m) return;
    let body = l;
    for (let j = i + 1; j < lines.length && !/^\s*\[IPC\./.test(lines[j]) && !/^\s*\/\/ (readonly|local|spend|ui)/.test(lines[j]) && j < i + 25; j++) body += '\n' + lines[j];
    const SKIP = new Set(['str', 'ok', 'Number', 'String', 'Math', 'max', 'min', 'async', 'return', 'if', 'await', 'throw', 'Error', 'catch', 'then', 'void', 'Boolean', 'join', 'map', 'filter', 'slice', 'test', 'includes', 'trim', 'push', 'nodeList']);
    const calls = [...body.replace(/^[^:]*:/, '').matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((x) => x[1]).filter((n) => !SKIP.has(n));
    out[m[1]] = { line: i + 1, calls: [...new Set(calls)].slice(0, 3) };
  });
  return out;
}

/** CLI command → test files that run it (scripts/e2e/*, scripts/e2e/android/* on the phone, tests/unit/*). */
function cliTests() {
  const files = [
    // Android suites first: this is the phone build, and the column shows the first few.
    // Sorted: NTFS lists names in order, ext4 in hash order; the doc must come out the same on both.
    ...fs.readdirSync('scripts/e2e/android').filter((f) => /\.(sh|mjs)$/.test(f)).sort().map((f) => `scripts/e2e/android/${f}`),
    ...fs.readdirSync('scripts/e2e').filter((f) => /\.(sh|ps1)$/.test(f)).sort().map((f) => `scripts/e2e/${f}`),
    ...fs.readdirSync('tests/unit').filter((f) => f.endsWith('.ts')).sort().map((f) => `tests/unit/${f}`),
  ];
  const texts = files.map((f) => [f, read(f)]);
  return (cmd) => {
    const words = cmd.split(' ').filter((w) => !w.startsWith('--'));
    // `-- cmd …` is the Android suites' form (cli-sweep.sh / settings-e2e.sh: run <exit> <want> <desc> -- cmd).
    const re = new RegExp(`(?:(?:dvpn|cli|Dvpn|run|\\$cli|\\bddv)\\b[^\\n]{0,40}|-- )\\b${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\b`);
    return texts.filter(([, t]) => re.test(t)).map(([f]) => path.basename(f));
  };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const RENDERER = walk('src/renderer/src').filter((f) => /\.tsx?$/.test(f)).map((f) => read(f)).join('\n');
const rendererUses = (key) => new RegExp(`IPC\\.${key}\\b`).test(RENDERER);

export function render(prev) {
  const rows = scan();
  const ch = channels();
  const { out: cli, variants } = cliMap();
  const h = handlers();
  const tests = cliTests();
  const byChan = {};
  for (const r of rows) for (const k of r.ipc) (byChan[k] ??= []).push(`${r.file.replace(/^screens\//, '').replace(/\.tsx$/, '')}:${r.line}`);
  const hand = prev && prev.includes(START) ? prev.slice(prev.indexOf(START), prev.indexOf(END) + END.length) : `${START}\n\n_(no hand traces yet)_\n\n${END}`;

  const t1 = ch.map((c) => {
    const m = cli[c.key];
    const cmd = m?.cli ? [m.cli, ...(variants[c.key] ?? [])] : [];
    const proof = [...new Set(cmd.flatMap((x) => tests(x)))];
    const used = byChan[c.key] ?? [];
    if (!used.length) used.push(rendererUses(c.key) ? 'no button: loaded by a screen' : '**not used by the app**');
    return `| \`${c.chan}\` | ${c.tier} | ipc.ts:${h[c.key]?.line ?? '—'} ${h[c.key]?.calls.map((x) => `\`${x}\``).join(' ') ?? ''} | ${m?.cli ? cmd.map((x) => `\`${x}\``).join(', ') : `none: ${m?.none ?? 'MISSING'}`} | ${proof.slice(0, 4).join(', ') || (m?.cli ? '**no CLI test**' : '—')} | ${used.length ? used.slice(0, 6).join(', ') + (used.length > 6 ? ` +${used.length - 6}` : '') : 'not on a screen'} |`;
  });
  const t2 = rows.map((r) => `| ${r.file}:${r.line} | ${r.tag} ${r.event} | ${r.label.replace(/\|/g, '/').replace(/`/g, "'") || '(no label)'} | ${r.hook ? `\`${r.hook}\`` : ''} | ${r.ipc.map((k) => `\`${ch.find((c) => c.key === k)?.chan ?? k}\``).join(', ') || 'local'} |`);
  const noCliTest = ch.filter((c) => cli[c.key]?.cli && ![cli[c.key].cli, ...(variants[c.key] ?? [])].some((x) => tests(x).length)).map((c) => c.chan);
  const unlabelled = rows.filter((r) => !r.label).length;

  return `# UI controls — every button, traced to code and the CLI

Generated by \`node scripts/ui-controls-doc.mjs\` (do not edit the tables by hand; the hand-written
trace section below is kept). \`tests/unit/ui-controls.test.ts\` fails when this file is stale, when a
control reaches an IPC channel that has no CLI mapping, or when a channel has no handler.

**Totals:** ${rows.length} controls, ${rows.filter((r) => r.ipc.length).length} reach the main process, ${ch.length} IPC channels, ${noCliTest.length} CLI-mapped channels with no script that runs the command, ${unlabelled} controls with no visible label (icon buttons: they carry \`aria-label\` or a title).

## By hand (Deep Inspection: control → handler → service → OS / chain / dvpnd)

${hand}

## 1. IPC channels → main handler → CLI → tests → screens

Tier: \`ui\`/\`readonly\` free, \`local\` changes this computer, \`spend\` signs a transaction (the
CLI needs \`--yes\`). "Tests" = test scripts or unit tests that run the CLI command.

| Channel | Tier | Main handler → first calls | CLI | Tests that run the CLI | Controls (file:line) |
|---|---|---|---|---|---|
${t1.join('\n')}

## 2. Every control

| Where | Element | Label | Test hook | IPC |
|---|---|---|---|---|
${t2.join('\n')}
`;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const prev = fs.existsSync(DOC) ? read(DOC) : '';
  const next = render(prev);
  if (process.argv.includes('--check')) {
    if (prev !== next) { console.error(`${DOC} is stale: run node scripts/ui-controls-doc.mjs`); process.exit(1); }
    console.log(`${DOC} up to date`);
  } else {
    fs.writeFileSync(DOC, next);
    console.log(`${DOC} written`);
  }
}
