// ─── APK third-party notices stay complete and current (OSS gate, the Android app items 2-5) ───
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script, no types
import { NOTICES_FILE, buildNotices, lockEntries } from '../../scripts/android-notices.mjs';

describe('android notices', () => {
  it(`${NOTICES_FILE} is up to date (npm run notices:android)`, () => {
    expect(fs.readFileSync(NOTICES_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(buildNotices());
  });

  it('every protocol program in the APK lock has a licence and a source link', () => {
    const lock = JSON.parse(fs.readFileSync('android/android-deps.lock.json', 'utf8')) as Array<Record<string, string>>;
    expect(lock.length).toBeGreaterThan(0);
    for (const r of lock) {
      expect(r.license, `${r.name} ${r.abi}`).toBeTruthy();
      expect(r.sourceUrl, `${r.name} ${r.abi}`).toMatch(/^https:\/\//);
    }
  });

  it('a lock row without a licence fails the build', () => {
    expect(() => lockEntries([{ name: 'xray', abi: 'x86_64', version: '1', source: 's', sha256: 'h' }])).toThrow(/no license/);
  });

  it('names the Sentinel attribution, dvpnd, Xray (MPL-2.0 + source), OpenVPN, the fonts and rpc-websockets', () => {
    const t = buildNotices() as string;
    expect(t).toContain('Built on Sentinel. https://sentinel.co');
    expect(t).toMatch(/dvpnd[\s\S]*Licence: Sentinel dVPN License/);
    expect(t).toMatch(/Xray 26\.3\.27[\s\S]*?Licence: MPL-2\.0\n\s+Source:\s+https:\/\/github\.com\/XTLS\/Xray-core\/tree\/v26\.3\.27/);
    expect(t).toContain('Licence: GPL-2.0');
    expect(t).toContain('SIL OPEN FONT LICENSE');
    expect(t).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
  });
});
