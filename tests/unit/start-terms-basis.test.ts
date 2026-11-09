// ─── Q0283: a deposit connect tells dvpnd the basis the user chose ───
// wx6: client.toml still said per_hour from an earlier cell; the app's per-GB connect ran on per-hour
// terms (node-4 prices both at 1000), so a used-up 1 GB deposit gave 2.3 GB and was never cut.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTermsBasis } from '../../src/core/daemon/client';

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('StartSession terms basis (Q0283)', () => {
  it("maps to dvpnd's session.Basis numbers", () => {
    expect(startTermsBasis('per_gb')).toBe(1);
    expect(startTermsBasis('per_hour')).toBe(2);
  });

  it('the daemon client sends terms.basis when given one', () => {
    const src = read('src/core/daemon/client.ts');
    expect(src).toMatch(/if \(basis\) req\.terms = \{ basis: startTermsBasis\(basis\) \}/);
    expect(src).toMatch(/'StartSession', req,/);
  });

  it('every deposit start passes the chosen basis; plan tickets do not', () => {
    const src = read('src/main/services/connection.ts');
    expect(src).toMatch(/daemon\(\)\.startSession\(node, cred, isTicket \? undefined : basis\)/);
    expect(src).toMatch(/startWithRetry\(req\.node, cred, !!req\.subscription, req\.basis\)/);
    expect(src).toMatch(/escrow: cost\.escrow \} \}, false, req\.basis\)/);
  });
});
