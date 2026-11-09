// ─── Q0271: the settings hook keeps early edits (wiring guard) ───
// settings-draft-early-edit.test.ts covers the merge itself; there is no React test runner here, so
// this guards the hook's use of it: the first read must merge (keepEdits) and every edit must be
// recorded as touched. Reverting only the hook (QA, Mac port) passed the merge test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, '../../src/renderer/src/lib/use-daemon-settings.ts'), 'utf8');

describe('useDaemonSettings wiring (Q0271)', () => {
  it('the first read keeps edits made before it answered', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*load\(\{ keepEdits: true \}\)/);
    expect(src).toMatch(/mergeLoaded\(d\.settings, prev, touched\.current\)/);
  });

  it('every edit through setDraft is recorded as touched', () => {
    expect(src).toMatch(/changedKeys\(prev, next\)\) touched\.current\.add\(k\)/);
  });
});
