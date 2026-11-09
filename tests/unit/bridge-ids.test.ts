// ─── Q0317: renderer call ids never repeat across page loads ───
// The Node engine outlives the page (renderer rebuilt after onRenderProcessGone, activity recreated).
// Ids starting at 1 on every load let a late reply to the old page's call resolve the new page's
// call with the same id, with the wrong result: a confirm dialog then closes with nothing sent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, '../../src/android/web-preload.ts'), 'utf8');

describe('bridge call ids (Q0317)', () => {
  it('start from the page load time, not a fixed number', () => {
    const m = /let nextId = (.+);/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/^\d+$/);
    expect(m![1]).toMatch(/Date\.now\(\)/);
  });

  it('the Kotlin bridge takes them as Long (an Int would truncate them)', () => {
    const kt = readFileSync(join(__dirname, '../../android/app/src/main/java/network/sentinel/devnetdvpn/MainActivity.kt'), 'utf8');
    expect(kt).toMatch(/fun invoke\(id: Long, channel: String, payloadJson: String\)/);
  });

  it('stay exact as JSON numbers', () => {
    const start = Date.now() * 1000;
    expect(Number.isSafeInteger(start + 10_000_000)).toBe(true);
    expect(JSON.parse(JSON.stringify({ id: start + 1 })).id).toBe(start + 1);
  });
});
