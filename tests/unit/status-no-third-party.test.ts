// ─── `status` contacts no third-party web service (Settings: "Off = never contacted") ───
// It used to fetch msftconnecttest.com and api.ipify.org with no session, whatever
// thirdPartyChecks said (C15, 019de2a). The internet probe is now the core TCP-only check. From the macOS app b252fa45.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(path.join(__dirname, '../../src/cli/status-cmd.ts'), 'utf8');

describe('status internet probe', () => {
  it('uses the core TCP-only reachability check', () => {
    expect(src).toMatch(/from '\.\.\/core\/quality\/reachability'/);
    expect(src).toMatch(/internetReachable\(getRpcUrls\(\)\)/);
  });

  it('fetches no outside site itself', () => {
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/connectivity-check|ipify|https?:\/\//);
  });
});
