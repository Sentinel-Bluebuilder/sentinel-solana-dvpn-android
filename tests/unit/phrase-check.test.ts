import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHRASE_CHECK_COUNT, pickCheckPositions, wrongPhraseWords } from '../../src/shared/phrase-check';

const PHRASE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

describe('recovery-phrase backup check (Q0297)', () => {
  it('asks for distinct positions inside the phrase, ascending', () => {
    for (let s = 0; s < 50; s++) {
      let x = s;
      const rand = (): number => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
      const p = pickCheckPositions(12, PHRASE_CHECK_COUNT, rand);
      expect(p).toHaveLength(3);
      expect(new Set(p).size).toBe(3);
      expect(p.every((i) => i >= 0 && i < 12)).toBe(true);
      expect([...p].sort((a, b) => a - b)).toEqual(p);
    }
  });

  it('accepts the right words, ignoring case and spaces', () => {
    expect(wrongPhraseWords(PHRASE, [0, 5, 11], ['alpha', ' Foxtrot ', 'LIMA'])).toEqual([]);
  });

  it('rejects a wrong word and names its position', () => {
    expect(wrongPhraseWords(PHRASE, [0, 5, 11], ['alpha', 'golf', 'lima'])).toEqual([5]);
  });

  it('rejects an empty answer: "I saved it" alone never passes', () => {
    expect(wrongPhraseWords(PHRASE, [1, 2, 3], ['', '', ''])).toEqual([1, 2, 3]);
    expect(wrongPhraseWords(PHRASE, [1, 2, 3], [])).toEqual([1, 2, 3]);
  });

  it('a 12-word phrase is checked on 3 words, a short one on all of them', () => {
    expect(pickCheckPositions(12)).toHaveLength(3);
    expect(pickCheckPositions(2)).toEqual([0, 1]);
  });
});

// The card must route "I saved it" through the check: reverting only the card (onClick={onDone}) fails here.
describe('phrase card wiring (Q0297)', () => {
  const src = readFileSync(join(__dirname, '../../src/renderer/src/screens/Onboarding.tsx'), 'utf8');
  it('"I saved it" opens the check instead of continuing', () => {
    expect(src).not.toMatch(/onClick=\{onDone\}>I saved it/);
    expect(src).toMatch(/setChecking\(true\);\s*\}\}>I saved it/);
  });
  it('only an all-correct check continues', () => {
    expect(src).toMatch(/const bad = wrongPhraseWords\(phrase, positions, answers\); if \(bad\.length\) setWrong\(bad\); else onDone\(\);/);
  });
});
