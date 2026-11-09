// ─── Q0339: a new session's deposit is listed at once, not at the next 60 s poll ───
// Connect, then open Activity: the deposit (and its Top up button) was missing for up to 60 s.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, '../../src/main/scheduler.ts'), 'utf8');
const tick = src.slice(src.indexOf('async function tick()'), src.indexOf('for (const j of jobs) {', src.indexOf('async function tick()')));

// the helper as the scheduler defines it (the module itself pulls in the app's services)
const helper = src.slice(src.indexOf('export function newSessionStarted'), src.indexOf('let settleForSession'));
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const newSessionStarted = new Function(`${helper.replace('export function', 'function').replace(/: string \| null/g, '').replace('): boolean', ')')} return newSessionStarted;`)() as (a: string | null, b: string | null) => boolean;

describe('settlements refresh when a session starts (Q0339)', () => {
  it('a new session id counts as started; the same id, or no session, does not', () => {
    expect(newSessionStarted(null, 's1')).toBe(true);
    expect(newSessionStarted('s1', 's2')).toBe(true);
    expect(newSessionStarted('s1', 's1')).toBe(false);
    expect(newSessionStarted('s1', null)).toBe(false);
    expect(newSessionStarted(null, null)).toBe(false);
  });

  it('every tick checks the session and makes the settlements job due at once', () => {
    expect(tick).toMatch(/newSessionStarted\(settleForSession, sid\)/);
    expect(tick).toMatch(/x\.name === 'settlements'\); if \(s\) s\.last = 0;/);
    expect(tick).toMatch(/settleForSession = sid;/);
  });
});
