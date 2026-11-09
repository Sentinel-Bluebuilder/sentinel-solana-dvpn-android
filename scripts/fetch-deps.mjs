// ─── fetch-deps — every third-party program the installer ships, pinned ───
// Reads build/deps.lock.json. For each dependency: download into build/.deps-cache
// (or reuse a cached copy), refuse on any SHA-256 mismatch, then:
//   msi → resources/deps/<file>.msi   (installed by resources/scripts/install-deps.ps1)
//   exe → its `dest`                  (protocol binaries the service finds on its PATH)
//   zip → only the listed `files` into `dest`
// Also checks the locally built binaries exist and writes THIRD-PARTY-NOTICES.txt.
// Usage: node scripts/fetch-deps.mjs [--offline]   (offline = cache only)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'deps.lock.json'), 'utf8'));
const CACHE = path.join(ROOT, 'build', '.deps-cache');
const DEPS_OUT = path.join(ROOT, 'resources', 'deps');
const offline = process.argv.includes('--offline');

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Copy unless the destination already has the same bytes (a running tunnel locks its exe). */
function copyIfChanged(src, dst) {
  if (fs.existsSync(dst) && sha256(dst) === sha256(src)) return;
  fs.copyFileSync(src, dst);
}

async function download(url, to) {
  if (offline) throw new Error(`offline and not cached: ${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'devnet-dvpn-build' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(`${to}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${to}.part`, to);
}

async function cached(dep) {
  const file = path.join(CACHE, path.basename(new URL(dep.url).pathname));
  if (!fs.existsSync(file) || sha256(file) !== dep.sha256) await download(dep.url, file);
  const got = sha256(file);
  if (got !== dep.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`${dep.name}: SHA-256 mismatch (want ${dep.sha256}, got ${got})`);
  }
  return file;
}

function extractZip(zip, dest, files) {
  const tmp = fs.mkdtempSync(path.join(CACHE, 'unzip-'));
  try {
    // Windows' own bsdtar (Windows 10+) reads zip; Git Bash's GNU tar would take "C:" for a host.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', zip, '-C', tmp], { stdio: 'inherit' });
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) {
      const src = path.join(tmp, f);
      if (!fs.existsSync(src)) throw new Error(`${path.basename(zip)} has no ${f}`);
      copyIfChanged(src, path.join(dest, f));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(DEPS_OUT, { recursive: true });
const manifest = [];
for (const dep of LOCK.deps) {
  const file = await cached(dep);
  if (dep.kind === 'msi') {
    const out = path.join(DEPS_OUT, path.basename(file));
    copyIfChanged(file, out);
    manifest.push({ name: dep.name, version: dep.version, file: path.basename(file), sha256: dep.sha256, signer: dep.signer });
  } else if (dep.kind === 'exe') {
    const out = path.join(ROOT, dep.dest);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    copyIfChanged(file, out);
  } else if (dep.kind === 'zip') {
    extractZip(file, path.join(ROOT, dep.dest), dep.files);
  } else {
    throw new Error(`${dep.name}: unknown kind ${dep.kind}`);
  }
  console.log(`ok   ${dep.name} ${dep.version}`);
}
// The install script checks each MSI against this list (hash + signer) before running it.
fs.writeFileSync(path.join(DEPS_OUT, 'deps.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const l of LOCK.local) {
  if (!fs.existsSync(path.join(ROOT, l.path))) throw new Error(`missing local binary ${l.path} (${l.note})`);
  console.log(`ok   ${l.name} (local, ${sha256(path.join(ROOT, l.path)).slice(0, 12)}…)`);
}

const notices = [
  'Devnet dVPN bundles the following third-party software, unmodified.',
  'Each is distributed under its own license; source code is available at the links below.',
  '',
  ...LOCK.deps.flatMap((d) => [
    `${d.title} ${d.version}`,
    `  License: ${d.license} (${d.licenseUrl})`,
    `  Source:  ${d.sourceUrl}`,
    `  SHA-256: ${d.sha256}`,
    '',
  ]),
];
fs.writeFileSync(path.join(ROOT, 'build', 'THIRD-PARTY-NOTICES.txt'), notices.join('\r\n'));
console.log('ok   build/THIRD-PARTY-NOTICES.txt');

// The installer's license page: our license, then every bundled component's.
const own = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').replace(/\r?\n/g, '\r\n');
const page = ['Devnet dVPN', '', own, '', '-'.repeat(72), '', ...notices].join('\r\n');
fs.writeFileSync(path.join(ROOT, 'build', 'license.txt'), page);
console.log('ok   build/license.txt');
