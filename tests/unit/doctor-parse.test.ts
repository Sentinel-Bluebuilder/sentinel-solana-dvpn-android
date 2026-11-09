// dvpnd doctor JSON changed case between dfe36c7 and cf4c372; the CLI crashed on `padEnd` of undefined.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/system/elevate', () => ({ runElevated: vi.fn() }));
vi.mock('../../src/main/store', () => ({ readJson: vi.fn(), writeJson: vi.fn() }));

import { parseDoctorRows } from '../../src/main/daemon/manager';

describe('parseDoctorRows', () => {
  it('reads cf4c372 lowercase rows (verbatim shape, 2026-10-21)', () => {
    const rows = parseDoctorRows('[{"detail":"no persisted kill switch","name":"kill_switch","ok":true},{"detail":"","name":"rpc","ok":true},{"detail":"holds no grant","name":"grant","ok":false}]');
    expect(rows.map((r) => `${r.name}:${r.level}`)).toEqual(['kill_switch:ok', 'rpc:ok', 'grant:fail']);
  });
  it('a failed grant row reads as plain copy, not a dvpnctl command', () => {
    const [g] = parseDoctorRows('[{"detail":"6dJ3 holds no grant; run dvpnctl grant open-grant --key <owner>","name":"grant","ok":false}]');
    expect(g.detail).not.toMatch(/dvpnctl|--key/);
    expect(g.detail).toMatch(/spending permission/);
  });
  it('still reads dfe36c7 capitalised rows', () => {
    expect(parseDoctorRows('[{"Name":"rpc","OK":false,"Detail":"x"}]')[0]).toEqual({ name: 'rpc', ok: false, level: 'fail', detail: 'x' });
  });
  it('cb33 mandate row reads like grant (app words)', () => {
    expect(parseDoctorRows('[{"name":"mandate","ok":false,"severity":"error","detail":"x"}]')[0].detail).toMatch(/no spending permission/);
  });
  it('cb33 severity: warning is a warning (kill_switch too, whatever its text); error fails', () => {
    const rows = parseDoctorRows(JSON.stringify([
      { name: 'kill_switch', ok: true, severity: 'warning', detail: 'held' },
      { name: 'kill_switch', ok: true, severity: 'ok', detail: 'leftover table' },
      { name: 'rpc', ok: true, severity: 'warning', detail: 'slow' },
      { name: 'rpc', ok: false, severity: 'error', detail: 'down' },
    ]), { android: true });
    expect(rows.map((r) => r.level)).toEqual(['warn', 'ok', 'warn', 'fail']);
  });
});

describe('doctor levels (owner laptop 2026-10-22: "!" on a healthy kill switch)', () => {
  it('kill switch with nothing held is OK, plain words', () => {
    const [r] = parseDoctorRows(JSON.stringify([{ name: 'kill_switch', ok: true, detail: 'no persisted kill switch' }]));
    expect(r.level).toBe('ok');
    expect(r.detail).toMatch(/Nothing held/);
  });
  it('kill switch unpinned is a warning; service_* advisories stay warnings; other OK rows are OK', () => {
    const rows = parseDoctorRows(JSON.stringify([
      { name: 'kill_switch', ok: true, detail: 'store unusable: x; checks run unpinned' },
      { name: 'service_adapter_openvpn', ok: true, detail: 'adapter missing' },
      { name: 'rpc', ok: true, detail: 'slot 123' },
    ]));
    expect(rows.map((r) => r.level)).toEqual(['warn', 'warn', 'ok']);
  });

  it('Android: wg / awg program rows are built in, other missing programs still warn', () => {
    const input = JSON.stringify([
      { name: 'service_binaries_wireguard', ok: true, detail: 'missing on PATH: [wg wg-quick]' },
      { name: 'service_binaries_amneziawg', ok: true, detail: 'missing on PATH: [awg awg-quick]' },
      { name: 'service_userspace_amneziawg', ok: true, detail: 'neither the amneziawg kernel module nor amneziawg-go found on PATH' },
      { name: 'service_binaries_v2ray', ok: true, detail: 'missing on PATH: [v2ray]' },
    ]);
    const phone = parseDoctorRows(input, { android: true });
    expect(phone.map((r) => r.level)).toEqual(['ok', 'ok', 'ok', 'warn']);
    expect(phone[0].detail).toMatch(/Built in on Android/);
    // Desktop keeps the warnings.
    expect(parseDoctorRows(input, { android: false }).map((r) => r.level)).toEqual(['warn', 'warn', 'warn', 'warn']);
  });
});
