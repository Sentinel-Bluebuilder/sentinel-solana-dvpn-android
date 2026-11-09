// ─── release-win — one command from a clean checkout to a verified Windows installer ───
// 1. fetch + verify every bundled dependency (build/deps.lock.json)
// 2. typecheck, unit tests          (a release never ships red)
// 3. build the app and the CLI
// 4. electron-builder → dist/Devnet-dVPN-Setup-<version>-x64.exe
// 5. dist/SHA256SUMS.txt for everything users download
// Usage: node scripts/release-win.mjs [--offline] [--skip-tests]
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const args = process.argv.slice(2);
const offline = args.includes('--offline');
const skipTests = args.includes('--skip-tests');

function step(title, cmd) {
  const t = Date.now();
  console.log(`\n─── ${title} ───\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  console.log(`ok (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}

if (process.platform !== 'win32') throw new Error('release-win runs on Windows (NSIS + signing tools)');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

step('dependencies', `node scripts/fetch-deps.mjs${offline ? ' --offline' : ''}`);
step('release version (L3)', 'node scripts/check-release-version.mjs' + (args.includes('--allow-same-version') ? ' --allow-same-version' : ''));
step('typecheck', 'npm run typecheck');
if (skipTests) console.log('\n─── unit tests SKIPPED (--skip-tests) ───');
else step('unit tests', 'npm test');
step('app build', 'npm run build');
step('CLI build', 'npm run build:cli');
if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
  console.log('\nnote: no CSC_LINK set → the installer is UNSIGNED (SmartScreen will say "Unknown publisher")');
}
step('installer', 'npx electron-builder --win --publish never');

const dist = path.join(ROOT, 'dist');
const setup = `Devnet-dVPN-Setup-${pkg.version}-x64.exe`;
if (!fs.existsSync(path.join(dist, setup))) throw new Error(`expected ${setup} in dist/`);
const files = fs.readdirSync(dist).filter((f) => /\.(exe|blockmap)$/i.test(f));
const sums = files.map((f) => `${createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
const mb = (fs.statSync(path.join(dist, setup)).size / 1048576).toFixed(1);
console.log(`\nrelease ready: dist/${setup} (${mb} MB)\n${sums.join('\n')}`);
