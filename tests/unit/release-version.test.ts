// ─── L3: a release must be higher than every shipped version ───
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain ESM script, no types
import { assertFreshVersion, compareVersions, gradleVersion, shippedVersions, checkRelease } from '../../scripts/lib/release-version.mjs';

const LEDGER = '# shipped\n0.1.0  first\n0.1.7  pkg #7 frozen\n\n';

describe('assertFreshVersion (L3)', () => {
  it('refuses the same version as a shipped build', () => {
    expect(() => assertFreshVersion('0.1.7', LEDGER)).toThrow(/not higher than the shipped 0\.1\.7/);
  });
  it('refuses a lower version than the highest shipped', () => {
    expect(() => assertFreshVersion('0.1.3', LEDGER)).toThrow(/not higher/);
  });
  it('accepts a bump, and compares numerically (0.1.10 > 0.1.9)', () => {
    expect(assertFreshVersion('0.1.8', LEDGER).ok).toBe(true);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
  });
  it('--allow-same-version is an explicit override', () => {
    expect(assertFreshVersion('0.1.7', LEDGER, { allowSame: true })).toMatchObject({ ok: true, overridden: true });
  });
  it('ignores comments and blank lines', () => {
    expect(shippedVersions(LEDGER)).toEqual(['0.1.0', '0.1.7']);
  });
  it('reads versionCode/versionName from the gradle file', () => {
    expect(gradleVersion('versionCode = 12\n versionName = "0.1.4"')).toEqual({ versionCode: 12, versionName: '0.1.4' });
  });
});

describe('this checkout (L3)', () => {
  const root = path.join(__dirname, '../..');
  it('has a ledger and the release scripts call the guard', () => {
    expect(fs.existsSync(path.join(root, 'docs', 'RELEASED-VERSIONS.txt'))).toBe(true);
    const rel = fs.readdirSync(path.join(root, 'scripts')).filter((f) => /^release-.*[.]mjs$/.test(f));
    expect(rel.length).toBeGreaterThan(0);
    for (const f of rel) expect(fs.readFileSync(path.join(root, 'scripts', f), 'utf8')).toContain('check-release-version');
  });
  it('the shipped version in package.json is refused unless overridden', () => {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const top = shippedVersions(fs.readFileSync(path.join(root, 'docs', 'RELEASED-VERSIONS.txt'), 'utf8')).sort(compareVersions).pop();
    if (compareVersions(v, top) > 0) expect(checkRelease(root).ok).toBe(true);
    else expect(() => checkRelease(root)).toThrow(/not higher/);
  });
});
