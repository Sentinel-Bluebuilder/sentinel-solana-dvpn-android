// ─── Generate docs/ANDROID-PARITY.md from evidence ───
// Rows: every CLI command (src/cli/catalogue.ts), every feature F1–F26 (docs/FEATURE-PLAN.md),
// the six protocols. Evidence:
//   test-results/android/<tier>.tsv          cli-sweep.sh output copied back from the rig
//   test-results/android/evidence.json       { "features": { "F14": "…" }, "protocols": { … }, "runs": [ … ] }
// A row with no evidence prints "—" and counts as open. Run: node scripts/gen-android-parity.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const resultsDir = path.join(root, 'test-results/android');

// ─── Inputs ───
const commands = [...read('src/cli/catalogue.ts').matchAll(/\{ cmd: '([^']+)', group: '([a-z]+)'/g)].map((m) => ({ cmd: m[1], group: m[2] }));
const features = [...read('docs/FEATURE-PLAN.md').matchAll(/^## (F\d+[ab]?) — (.+)$/gm)].map((m) => ({ id: m[1], title: m[2] }));
const evidence = fs.existsSync(path.join(resultsDir, 'evidence.json')) ? JSON.parse(fs.readFileSync(path.join(resultsDir, 'evidence.json'), 'utf8')) : {};
const rows = [];
const naRows = []; // grid/edge cells that cannot apply (stated reason), never counted as a pass
for (const f of fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((n) => n.endsWith('.tsv')).sort() : []) {
  const tier = f.replace(/\.tsv$/, '');
  for (const line of fs.readFileSync(path.join(resultsDir, f), 'utf8').split('\n')) {
    const [status, desc, cmd] = line.split('\t');
    if (status === 'PASS' || status === 'FAIL') rows.push({ tier, status, desc, cmd: cmd ?? '' });
    else if (status === 'NA') naRows.push({ tier, status, desc, cmd: cmd ?? '' });
  }
}

// ─── CLI rows: a command is proven when at least one sweep check ran it and none failed ───
// `connect --follow` style entries: the base command with that flag anywhere in the arguments.
const runs = (r, cmd) => {
  const [base, flag] = cmd.split(/ (?=--)/);
  if (flag) return (r.cmd === base || r.cmd.startsWith(`${base} `)) && r.cmd.split(' ').includes(flag);
  return r.cmd === cmd || r.cmd.startsWith(`${cmd} `);
};
const forCmd = (cmd) => rows.filter((r) => runs(r, cmd));
// Longest-match: `wallet send` rows must not also count for `wallet` alone.
const owner = (r) => commands.map((c) => c.cmd).filter((c) => runs(r, c)).sort((a, b) => b.length - a.length)[0];
let cliDone = 0;
const cliLines = commands.map(({ cmd, group }) => {
  const mine = forCmd(cmd).filter((r) => owner(r) === cmd);
  const pass = mine.filter((r) => r.status === 'PASS');
  const fail = mine.filter((r) => r.status === 'FAIL');
  const tiers = [...new Set(pass.map((r) => r.tier))].join(', ');
  const done = pass.length > 0 && fail.length === 0;
  if (done) cliDone++;
  const ev = !mine.length ? '—' : `${pass.length} pass${fail.length ? `, **${fail.length} FAIL**` : ''} (${tiers || 'no pass'})`;
  return `| \`${cmd}\` | ${group} | ${ev} | ${done ? 'yes' : 'no'} |`;
});

// ─── Feature rows: the sweep commands and feature-check tags that exercise each feature ───
// A feature is done when it has at least one passing check and none failing; hand-written notes
// (evidence.json, e.g. proto-check / lockdown runs) are added beside the counts.
const FEATURE_CHECKS = {
  F1: ['feature:F1', 'daemon init', 'daemon doctor', 'daemon drivers', 'daemon version', 'version'],
  F2: ['wallet'],
  F3: ['device'],
  F4: ['rpc'],
  F5: ['poll'],
  F6: ['nodes list', 'nodes show'],
  F7: ['nodes', 'feature:F25'],
  F8: ['cost', 'test plan'],
  F9: ['connect', 'disconnect', 'status', 'quality ip'],
  F10: ['plans'],
  F11: ['feature:F11', 'connect'],
  F12: ['disconnect', 'settle'],
  F13: ['sessions', 'channels', 'history', 'tickets'],
  F14: ['feature:F14'],
  F15: ['feature:F15'],
  F16: ['split'],
  F17: ['connect', 'quality ip'],
  F18: ['settings', 'daemon set', 'daemon settings'],
  F19: ['quality', 'daemon doctor'],
  F20: ['test'],
  F21: ['feature:F21'],
  F22: ['version', 'daemon version'],
  F24: ['feature:F24'],
  F25: ['feature:F25'],
};
const featRows = (id) => {
  // F23 (errors and copy): every refusal the sweep checks; F26 (testing): everything.
  if (id === 'F23') return rows.filter((r) => /refuse|rejects|needs|without|usage error|stops for/i.test(r.desc));
  if (id === 'F26') return rows;
  // F24 also: the "wallet secret is sealed" sweep check (a plain check row, no command).
  if (id === 'F24') return rows.filter((r) => r.cmd === 'feature:F24' || /sealed|secret/i.test(r.desc));
  const keys = FEATURE_CHECKS[id] ?? [];
  // grid:F9:wireguard, grid:F9.2:…, edge:F14:… rows count for their feature too.
  const cell = (r) => { const m = /^(?:grid|edge):(F\d+)(?:\.\d+)?:/.exec(r.cmd); return m && m[1] === id; };
  return rows.filter((r) => cell(r) || keys.some((k) => r.cmd === k || r.cmd.startsWith(`${k} `)));
};
let featDone = 0;
const featLines = features.map(({ id, title }) => {
  const mine = featRows(id);
  const pass = mine.filter((r) => r.status === 'PASS').length;
  const fail = mine.length - pass;
  const tiers = [...new Set(mine.map((r) => r.tier))].join(', ');
  const counted = mine.length ? `${pass} pass${fail ? `, **${fail} FAIL**` : ''} (${tiers})` : '';
  const note = evidence.features?.[id];
  const done = fail === 0 && (pass > 0 || !!note);
  if (done) featDone++;
  return `| ${id} | ${title} | ${[counted, note].filter(Boolean).join(' · ') || '—'} | ${done ? 'yes' : 'no'} |`;
});

const PROTOCOLS = ['wireguard', 'amneziawg', 'openvpn', 'v2ray', 'xray', 'hysteria2'];
const protoLines = PROTOCOLS.map((p) => {
  const e = evidence.protocols?.[p] ?? {};
  const sweep = rows.filter((r) => r.tier === 'spend' && r.desc.toLowerCase().includes(p));
  const sweepEv = sweep.length ? `${sweep.filter((r) => r.status === 'PASS').length}/${sweep.length} spend checks` : '—';
  return `| ${p} | ${e.protoCheck ?? '—'} | ${e.lockdown ?? '—'} | ${sweepEv} | ${e.realDevice ?? '—'} |`;
});

// ─── Feature × protocol grid (grid.sh) and adversarial cases (edge.sh, netlab.sh, soak.sh) ───
// A cell: ✅ n = every check passed, ❌ = any failed, n/a = cannot apply (reason in the TSV), blank = not run.
const cellTable = (prefix) => {
  const all = [...rows, ...naRows].filter((r) => r.cmd.startsWith(prefix + ':'));
  const keyOf = (r) => r.cmd.split(':')[1];
  const keys = [...new Set(all.map(keyOf))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const lines = keys.map((k) => {
    const cells = PROTOCOLS.map((proto) => {
      const mine = all.filter((r) => keyOf(r) === k && r.cmd.split(':')[2] === proto);
      if (!mine.length) return ' ';
      const f = mine.filter((r) => r.status === 'FAIL').length;
      const okN = mine.filter((r) => r.status === 'PASS').length;
      if (f) return `❌ ${f}/${okN + f}`;
      return okN ? `✅ ${okN}` : 'n/a';
    });
    const other = all.filter((r) => keyOf(r) === k && !PROTOCOLS.includes(r.cmd.split(':')[2]));
    const otherCell = other.length ? (other.some((r) => r.status === 'FAIL') ? '❌' : other.some((r) => r.status === 'PASS') ? `✅ ${other.length}` : 'n/a') : ' ';
    return `| ${k} | ${cells.join(' | ')} | ${otherCell} |`;
  });
  return lines.length ? lines.join('\n') : '| (not run yet) |  |  |  |  |  |  |  |';
};
const gridLines = cellTable('grid');
const edgeLines = [cellTable('edge'), cellTable('netlab'), cellTable('soak')].filter((l) => !l.includes('not run yet')).join('\n') || '| (not run yet) |  |  |  |  |  |  |  |';

const totalFail = rows.filter((r) => r.status === 'FAIL').length;
const out = `# Android parity (the Android app vs the Windows app)

Generated by \`node scripts/gen-android-parity.mjs\` from \`test-results/android/\`. Do not edit by hand.
A row is done only with evidence from the Android rig (emulator, \`test-host\`).

**Summary:** CLI commands ${cliDone}/${commands.length} proven · features ${featDone}/${features.length} with evidence ·
sweep checks ${rows.length} (${totalFail} FAIL)${(evidence.runs ?? []).length ? ` · runs: ${evidence.runs.join('; ')}` : ''}

## Protocols

| Protocol | proto-check (9 checks) | lockdown | CLI spend sweep | Real phones (Firebase Test Lab) |
|---|---|---|---|---|
${protoLines.join('\n')}

## Every feature × every protocol (scripts/e2e/android/grid.sh)

| Feature | WireGuard | AmneziaWG | OpenVPN | V2Ray | Xray | Hysteria2 | once |
|---|---|---|---|---|---|---|---|
${gridLines}

## Adversarial and edge cases (edge.sh, netlab.sh, soak.sh; ported from the Windows suites)

| Case | WireGuard | AmneziaWG | OpenVPN | V2Ray | Xray | Hysteria2 | other |
|---|---|---|---|---|---|---|---|
${edgeLines}

## Features (docs/FEATURE-PLAN.md)

| Id | Feature | Android evidence | Done |
|---|---|---|---|
${featLines.join('\n')}

## CLI commands (src/cli/catalogue.ts)

| Command | Group | Sweep evidence | Done |
|---|---|---|---|
${cliLines.join('\n')}
`;
fs.writeFileSync(path.join(root, 'docs/ANDROID-PARITY.md'), out, 'utf8');
console.log(`ANDROID-PARITY.md: cli ${cliDone}/${commands.length}, features ${featDone}/${features.length}, checks ${rows.length} (${totalFail} FAIL)`);
