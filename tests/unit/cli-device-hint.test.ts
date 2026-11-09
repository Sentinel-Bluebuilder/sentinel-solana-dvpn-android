// ─── L1: `device setup` with NO wallet must not send the user to `daemon init` ───
// The device-key hint is only true for a wallet that exists; without one the service's own
// "Create or import a wallet first" is the right step (composed-app sweep, 10-24).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('device setup hint (L1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/cli/commands.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('has no device key yet')) ?? '';
  it('exists', () => expect(line).not.toBe(''));
  it('is guarded by a wallet check', () => expect(line).toMatch(/ownerAddress\(\)\s*&&\s*!daemonInfo\(\)\.device/));
});
