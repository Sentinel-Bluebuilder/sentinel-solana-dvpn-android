// Q0361/Q0366: the shown-session check only helps if the session poll runs it while a session is
// shown. Nothing else fails when the job skips it (QA 08e7c241 found the same gap on Mac).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '../../src/main/scheduler.ts'), 'utf8');

describe('session poll wiring (Q0361)', () => {
  it('the session job runs reconcileShownSession while a session is shown', () => {
    const job = src.slice(src.indexOf("name: 'session'"), src.indexOf("name: 'rpc'"));
    expect(job.length).toBeGreaterThan(0);
    expect(job).toMatch(/if \(s\.session\)[^\n]*reconcileShownSession\(\)/);
  });
});
