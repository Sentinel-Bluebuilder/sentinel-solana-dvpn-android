// ─── Q0313: after a good Repair drivers, Diagnostics reads the drivers again ───
// The repair's own report could be the check from before it ran, so "Repair drivers" stayed on
// screen for 5+ minutes after a successful repair. A good repair now re-reads DRIVERS_STATUS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, '../../src/renderer/src/screens/Diagnostics.tsx'), 'utf8');
// the body of repair(): from its declaration to the effect that loads the page
const repair = src.slice(src.indexOf('const repair = '), src.indexOf('useEffect('));

describe('Diagnostics after Repair drivers (Q0313)', () => {
  it('a successful repair re-reads the driver status', () => {
    expect(repair).toMatch(/if \(r\.ok\) setDrivers\(await call<DriversView>\(window\.api\.IPC\.DRIVERS_STATUS/);
  });

  it('it re-reads after showing the repair result, so the fresh check is what stays', () => {
    expect(repair.indexOf('IPC.DRIVERS_STATUS')).toBeGreaterThan(repair.indexOf('setDrivers(r.view)'));
  });

  it('a failed repair does not re-read (its error stays on screen)', () => {
    expect(repair).not.toMatch(/^\s*setDrivers\(await call<DriversView>\(window\.api\.IPC\.DRIVERS_STATUS/m);
  });
});
