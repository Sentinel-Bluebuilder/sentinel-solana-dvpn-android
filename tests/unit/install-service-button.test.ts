// ─── Q0305: a set-up device whose service is gone can install it again ───
// The "not answering" banner pointed at Diagnostics, and Diagnostics had no install: no way back
// short of reinstalling the app. Both now carry the onboarding install (DAEMON_INIT install).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lostSetupCopy } from '../../src/core/session/setup-gate';

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('Install service after setup (Q0305)', () => {
  it('the button runs the onboarding install and exposes its state', () => {
    const src = read('src/renderer/src/components/InstallServiceButton.tsx');
    expect(src).toMatch(/call\(window\.api\.IPC\.DAEMON_INIT, \{ step: 'install' \}\)/);
    expect(src).toMatch(/data-install-service=\{state\}/);
  });

  it('the lost-service banner offers it', () => {
    expect(lostSetupCopy('service')?.text).toMatch(/not answering/);
    expect(read('src/renderer/src/App.tsx')).toMatch(/action=\{step === 'service' \? <InstallServiceButton \/>/);
  });

  it('Diagnostics offers it while the service does not answer', () => {
    expect(read('src/renderer/src/screens/Diagnostics.tsx')).toMatch(/\{!d\.reachable && <div[^>]*data-service-missing>.*<InstallServiceButton \/><\/div>\}/);
  });
});
