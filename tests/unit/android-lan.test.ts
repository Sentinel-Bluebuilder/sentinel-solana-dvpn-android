import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANDROID_LAN_RANGES } from '../../src/shared/android-lan';

describe('Allow local network ranges (page = VPN engine)', () => {
  it('the page lists exactly what RouteSplit.kt leaves out', () => {
    const kt = fs.readFileSync('android/app/src/main/java/network/sentinel/devnetdvpn/vpn/RouteSplit.kt', 'utf8');
    const m = /val LAN = listOf\(([^)]*)\)/.exec(kt);
    expect(m, 'RouteSplit.LAN not found').not.toBeNull();
    const kotlin = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(kotlin).toEqual([...ANDROID_LAN_RANGES]);
  });
});
