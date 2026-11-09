// ─── Piped Windows output is ASCII (cp437 readers showed "…" as junk) ───
import { describe, expect, it } from 'vitest';
import { consoleText, foldAscii } from '../../src/cli/console-text';

describe('foldAscii', () => {
  it('maps punctuation and strips accents', () => {
    expect(foldAscii('Connecting… · ok → next — São Paulo ✓')).toBe('Connecting... - ok -> next - Sao Paulo OK');
  });
  it('leaves ASCII alone and marks the rest', () => {
    expect(foldAscii('plain 123')).toBe('plain 123');
    expect(foldAscii('東京')).toBe('??');
  });
});

describe('consoleText', () => {
  it('folds only for piped output on Windows', () => {
    const piped = consoleText('a…b', { isTTY: false });
    const tty = consoleText('a…b', { isTTY: true });
    expect(tty).toBe('a…b');
    expect(piped).toBe(process.platform === 'win32' ? 'a...b' : 'a…b');
  });
});
