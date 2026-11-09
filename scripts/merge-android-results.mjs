#!/usr/bin/env node
// ─── Merge rig result files: the newest row per check wins ───
// Usage: node scripts/merge-android-results.mjs <out.tsv> <oldest.tsv> … <newest.tsv>
// A row is PASS|FAIL|NA <tab> description <tab> tag [<tab> detail]. The key is tag + description,
// so a retest on a later build replaces the superseded row and a check that only the old run had
// is kept. Writes <out.tsv> and prints how many rows each input contributed.
import fs from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error('usage: merge-android-results.mjs <out.tsv> <oldest.tsv> … <newest.tsv>');
  process.exit(3);
}

const rows = new Map();
const from = new Map();
for (const file of inputs) {
  const parsed = fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.replace(/\r$/, '').split('\t'))
    .filter((cols) => cols.length >= 3 && /^(PASS|FAIL|NA)$/.test(cols[0]));
  // A later file that tested a case (tag) replaces every older row of that case, also rows whose
  // wording changed between builds (an old FAIL under an old description must not survive).
  const tags = new Set(parsed.map((cols) => cols[2]));
  for (const key of [...rows.keys()]) if (tags.has(key.split('\t')[0])) { rows.delete(key); from.delete(key); }
  for (const cols of parsed) {
    const key = `${cols[2]}\t${cols[1]}`;
    rows.set(key, cols.join('\t'));
    from.set(key, file);
  }
}

fs.writeFileSync(out, [...rows.values()].join('\n') + '\n');
const counts = {};
for (const f of from.values()) counts[f] = (counts[f] ?? 0) + 1;
const tally = { PASS: 0, FAIL: 0, NA: 0 };
for (const r of rows.values()) tally[r.split('\t')[0]]++;
console.log(`${out}: ${rows.size} checks (PASS ${tally.PASS}, FAIL ${tally.FAIL}, NA ${tally.NA})`);
for (const [f, n] of Object.entries(counts)) console.log(`  ${n} from ${f}`);
