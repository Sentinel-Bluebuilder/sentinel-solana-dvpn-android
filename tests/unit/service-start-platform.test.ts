// ─── startServiceIfStopped off Windows ───
// Found by the Android app: off win32 it returned 'no-service', so connect with dvpnd stopped
// showed the "not installed … reinstall" copy for a service that was only stopped.
// Windows-app code only: a port that really queries its service manager (Mac launchd says
// 'no-service' only when the plist is gone, the macOS app) keeps its own rule and drops this test.
import { afterEach, describe, expect, it } from 'vitest';
import { startServiceIfStopped } from '../../src/main/daemon/manager';

const real = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: real }); });

describe('startServiceIfStopped', () => {
  it.each(['linux', 'darwin'])('on %s never claims the service is missing', async (p) => {
    Object.defineProperty(process, 'platform', { value: p });
    await expect(startServiceIfStopped()).resolves.toBe('failed');
  });
});
