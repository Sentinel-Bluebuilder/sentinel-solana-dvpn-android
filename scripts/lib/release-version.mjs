// ─── Same-version reinstall guard (fleet-bugs L3) ───
// `apt-get install ./x.deb`, `dnf install`, MSI and a same-versionCode APK over an installed build of
// the SAME version are silent no-ops: a test then runs the OLD build while believing it is the new
// one. A release must therefore carry a version higher than every version already shipped. The
// shipped versions are listed in docs/RELEASED-VERSIONS.txt: one `<version>  <note>` per line.
import fs from 'node:fs';
import path from 'node:path';

/** Numeric [major, minor, patch] of `x.y.z` (a -suffix is ignored), or null. */
export function parseVersion(v) {
  const m = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`cannot compare versions "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The shipped versions listed in the ledger text (comments and blank lines skipped). */
export function shippedVersions(ledgerText) {
  return ledgerText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]).filter((v) => parseVersion(v));
}

/**
 * Throws when `version` is not higher than the highest shipped version. `allowSame` is the explicit
 * override (a rebuild that is NOT meant to be installed over the shipped one).
 */
export function assertFreshVersion(version, ledgerText, { allowSame = false } = {}) {
  if (!parseVersion(version)) throw new Error(`package.json version "${version}" is not x.y.z`);
  const shipped = shippedVersions(ledgerText);
  const top = shipped.reduce((a, b) => (a === null || compareVersions(b, a) > 0 ? b : a), null);
  if (top === null || compareVersions(version, top) > 0) return { ok: true, highestShipped: top };
  if (allowSame) return { ok: true, highestShipped: top, overridden: true };
  throw new Error(`version ${version} is not higher than the shipped ${top} (docs/RELEASED-VERSIONS.txt). `
    + 'Installing it over the shipped build is a silent no-op (apt/dnf "already the newest version", MSI same ProductVersion, same APK versionCode), '
    + 'so a test would run the OLD build. Bump "version" in package.json (and versionCode/versionName in the Android gradle file), or pass --allow-same-version for a build that is never installed over a shipped one.');
}

/** versionName / versionCode from an Android build.gradle.kts text, or null. */
export function gradleVersion(text) {
  const code = /versionCode\s*=\s*([0-9]+)/.exec(text), name = /versionName\s*=\s*"([^"]+)"/.exec(text);
  return code && name ? { versionCode: Number(code[1]), versionName: name[1] } : null;
}

/** Reads package.json + the ledger under `root` and applies the check (also the Android gradle file when present). */
export function checkRelease(root, opts = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ledger = fs.readFileSync(path.join(root, 'docs', 'RELEASED-VERSIONS.txt'), 'utf8');
  const r = assertFreshVersion(pkg.version, ledger, opts);
  const gradle = path.join(root, 'android', 'app', 'build.gradle.kts');
  if (fs.existsSync(gradle)) {
    const g = gradleVersion(fs.readFileSync(gradle, 'utf8'));
    if (!g) throw new Error('android/app/build.gradle.kts has no versionCode/versionName');
    if (g.versionName !== pkg.version) throw new Error(`Android versionName ${g.versionName} differs from package.json ${pkg.version}`);
    const codes = ledger.split('\n').map((l) => /versionCode=([0-9]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    const topCode = codes.length ? Math.max(...codes) : 0;
    if (g.versionCode <= topCode && !opts.allowSame) throw new Error(`Android versionCode ${g.versionCode} is not higher than the shipped ${topCode} (docs/RELEASED-VERSIONS.txt)`);
  }
  return r;
}
