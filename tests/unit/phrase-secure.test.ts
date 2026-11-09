// ─── Recovery phrase card is FLAG_SECURE on Android (Q0297 Android gap) ───
// The 24 words must not land in a screenshot, a screen recording or the Recents thumbnail. Wiring test over the
// sources, same style as phrase-check.test.ts (which stays byte-identical to the shared app's).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('recovery phrase card: FLAG_SECURE on Android', () => {
  const card = read('src/renderer/src/screens/Onboarding.tsx');
  const body = card.slice(card.indexOf('function PhraseCard'), card.indexOf('function WalletStep'));

  it('the card turns it on when shown and off when it goes away (check step included)', () => {
    expect(body).toMatch(/useEffect\(\(\) => \{\s*window\.api\.android\?\.setSecure\(true\);\s*return \(\) => window\.api\.android\?\.setSecure\(false\);\s*\}, \[\]\);/);
  });

  it('the effect runs before the check step returns early, so the check is covered too', () => {
    expect(body.indexOf('setSecure(true)')).toBeGreaterThan(-1);
    expect(body.indexOf('setSecure(true)')).toBeLessThan(body.indexOf('if (checking)'));
  });

  it('off Android it is a no-op (optional chaining on window.api.android)', () => {
    expect(body).not.toMatch(/window\.api\.android\.setSecure/);
  });

  it('the WebView preload forwards it to the Kotlin bridge, tolerating an older shell', () => {
    const pre = read('src/android/web-preload.ts');
    expect(pre).toMatch(/setSecure\?\(on: boolean\): void;/);
    expect(pre).toMatch(/setSecure\(on: boolean\): void \{ native\?\.setSecure\?\.\(on\); \}/);
    expect(read('src/preload/index.d.ts')).toMatch(/setSecure\(on: boolean\): void/);
  });

  it('the Kotlin bridge adds and clears FLAG_SECURE on the UI thread', () => {
    const kt = read('android/app/src/main/java/network/sentinel/devnetdvpn/MainActivity.kt');
    const fn = kt.slice(kt.indexOf('fun setSecure('), kt.indexOf('fun welcomed('));
    expect(kt).toMatch(/@JavascriptInterface\s+fun setSecure\(on: Boolean\)/);
    expect(fn).toMatch(/ui\.post \{/);
    expect(fn).toMatch(/window\.addFlags\(android\.view\.WindowManager\.LayoutParams\.FLAG_SECURE\)/);
    expect(fn).toMatch(/window\.clearFlags\(android\.view\.WindowManager\.LayoutParams\.FLAG_SECURE\)/);
  });
});
