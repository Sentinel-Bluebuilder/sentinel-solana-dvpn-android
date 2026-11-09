// ─── Inventory of every interactive control in the renderer (button audit, U3) ───
// Finds each onClick / onChange / onSubmit / onKeyDown handler in src/renderer/src/**/*.tsx,
// the element and visible label around it, and the IPC channels the handler reaches
// (directly, or through a function/hook defined in the same file or in lib/). Prints JSON,
// or with --md the table body for docs/UI-CONTROLS.md. tests/unit/ui-controls.test.ts uses
// the same scan so a new control without a documented row fails.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'src/renderer/src';
// Every on<Event>= prop: DOM events plus component callbacks such as ConfirmModal onConfirm,
// where most money/network actions live behind a "Settle now" or "Top up" that only opens a modal.
const HANDLER = /\b(on[A-Z]\w*)=\{/g;

function walk(dir) {
  // Sorted: NTFS lists names in order, ext4 in hash order; output must be the same on both.
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : [];
  });
}

/** Text from `start` (an opening `{`) to its matching `}`. */
function braced(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return src.slice(start + 1);
}

/** Bodies of named functions/consts in a file: name → body text. */
function functionBodies(src) {
  const out = new Map();
  const re = /(?:function\s+(\w+)\s*\([^)]*\)[^{]*|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>\s*)\{/g;
  for (const m of src.matchAll(re)) out.set(m[1] ?? m[2], braced(src, m.index + m[0].length - 1));
  // Expression-bodied arrows: const load = (): Promise<void> => run('x', async () => …IPC.X…);
  // (the body runs until brackets balance and a ; or newline closes the statement).
  const expr = /const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*(?!\{)/g;
  for (const m of src.matchAll(expr)) {
    if (out.has(m[1])) continue;
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if ('({['.includes(c)) depth++;
      else if (')}]'.includes(c)) depth--;
      else if ((c === ';' || c === '\n') && depth <= 0) break;
    }
    out.set(m[1], src.slice(m.index + m[0].length, i));
  }
  return out;
}

const libBodies = new Map();
for (const f of walk(path.join(ROOT, 'lib'))) for (const [k, v] of functionBodies(fs.readFileSync(f, 'utf8'))) libBodies.set(k, v);

function channels(code, bodies, seen = new Set()) {
  const found = new Set([...code.matchAll(/IPC\.([A-Z_]+)/g)].map((m) => m[1]));
  for (const m of code.matchAll(/\b([a-z]\w*)\s*\(/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const body = bodies.get(name) ?? libBodies.get(name);
    if (body) for (const c of channels(body, bodies, seen)) found.add(c);
  }
  return found;
}

/** Element tag + a readable label for the control whose handler starts at `idx`. */
/** End of the JSX opening tag that starts at `open` (skips `>` inside `{…}`), and whether it self-closes. */
function tagEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return { end: i, self: src[i - 1] === '/' };
  }
  return { end: src.length, self: true };
}

/** Opening `<tag` that owns the attribute at `idx` (walks back over nested `{…}`). */
function ownerOpen(src, idx) {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') depth--;
    else if (c === '<' && depth <= 0 && /[A-Za-z]/.test(src[i + 1] ?? '')) return i;
  }
  return 0;
}

function describe(src, idx) {
  const open = ownerOpen(src, idx);
  const tag = (src.slice(open + 1).match(/^[\w.]+/) ?? ['?'])[0];
  const { end, self } = tagEnd(src, open);
  const close = self ? -1 : src.indexOf('</' + tag + '>', end);
  let inner = close > 0 ? src.slice(end + 1, close) : '';
  const attrs = src.slice(open, end);
  const aria = attrs.match(/aria-label=\{?["'`]([^"'`]+)/)?.[1];
  const data = attrs.match(/(data-[\w-]+)/)?.[1];
  // Visible text: drop nested tags, keep string literals from {…} (e.g. busy ? 'Applying…' : 'Apply').
  inner = inner.replace(/<[^>]*>/g, ' ');
  for (let k = 0; k < 4; k++) inner = inner.replace(/\{[^{}]*\}/g, (m) => ` ${[...m.matchAll(/'([^']{2,})'/g)].map((x) => x[1]).join(' / ')} `);
  inner = inner.replace(/\s+/g, ' ').trim();
  // A <label> wrapping an input: take the label's text instead.
  let label = aria || inner;
  if (!label && tag === 'input') {
    const lab = src.lastIndexOf('<label', open);
    const labEnd = src.indexOf('</label>', idx);
    if (lab >= 0 && labEnd > idx && labEnd - lab < 1200) label = src.slice(lab, labEnd).replace(/<[^>]*>/g, ' ').replace(/\{[^{}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label) label = attrs.match(/placeholder=["']([^"']+)/)?.[1] ?? '';
  }
  return { tag, label: (label || data || '').slice(0, 70), hook: data ?? '' };
}

export function scan() {
  const rows = [];
  for (const file of walk(ROOT).filter((f) => f.endsWith('.tsx'))) {
    const src = fs.readFileSync(file, 'utf8');
    const bodies = functionBodies(src);
    for (const m of src.matchAll(HANDLER)) {
      const code = braced(src, m.index + m[0].length - 1);
      const line = src.slice(0, m.index).split('\n').length;
      const d = describe(src, m.index);
      rows.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line,
        event: m[1],
        tag: d.tag,
        label: d.label,
        hook: d.hook,
        ipc: [...channels(code, bodies)].sort(),
      });
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const rows = scan();
  if (process.argv.includes('--md')) {
    for (const r of rows) console.log(`| ${r.file}:${r.line} | ${r.tag} ${r.event} | ${r.label.replace(/\|/g, '/')} | ${r.ipc.join(', ') || 'local'} |`);
  } else console.log(JSON.stringify(rows, null, 2));
  console.error(`${rows.length} controls, ${rows.filter((r) => r.ipc.length).length} reach IPC`);
}
