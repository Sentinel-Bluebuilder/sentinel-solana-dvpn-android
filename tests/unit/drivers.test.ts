import { describe, expect, it } from 'vitest';
import { adapterMissingIn, driverCheckTimeoutMs, driverLines, openvpnAdapterName, parseReport } from '../../src/main/system/drivers';

// Shapes copied from real install-deps.ps1 output (PowerShell 5.1 ConvertTo-Json, 2026-10-20).
const REAL = `﻿{
    "schema":  1,
    "at":  "2026-10-20T15:35:02.0205303Z",
    "ok":  true,
    "rebootRequired":  false,
    "deps":  [
                 { "name":  "wireguard", "wanted":  "1.1.1", "found":  "0.5.3", "status":  "present", "detail":  "older than bundled; repair upgrades it" },
                 { "name":  "openvpn-wintun", "wanted":  "OpenVPN Wintun", "found":  "OpenVPN Wintun", "status":  "present", "detail":  "" }
             ]
}`;

describe('driver report', () => {
  it('parses the script output, BOM included', () => {
    const r = parseReport(REAL)!;
    expect(r.ok).toBe(true);
    expect(r.deps.map((d) => d.name)).toEqual(['wireguard', 'openvpn-wintun']);
  });

  it('accepts a one-driver report that PowerShell wrote as a bare object', () => {
    const r = parseReport('{"ok":false,"rebootRequired":false,"at":"x","deps":{"name":"openvpn","wanted":"2.6.23-I002","found":"2.7.8","status":"incompatible","detail":"2.7 removed Wintun"}}')!;
    expect(r.ok).toBe(false);
    expect(r.deps).toHaveLength(1);
    expect(driverLines(r)[0]).toMatch(/^FAIL\s+OpenVPN\s+incompatible 2\.7\.8/);
  });

  it('marks missing drivers distinctly from failures', () => {
    const r = parseReport('{"ok":false,"deps":[{"name":"amneziawg","wanted":"3.1.0","found":"","status":"missing","detail":""}]}')!;
    expect(driverLines(r)[0]).toMatch(/^miss\s+AmneziaWG\s+missing$/);
  });
});

// UPSTREAM-GAPS #83: the arm64 OpenVPN MSI has no Wintun; dvpnd uses ovpn-dco and its DCO adapter there.
describe('openvpn adapter per CPU (#83)', () => {
  // tapctl list on test-host (Win11 ARM64, OpenVPN 2.6.23 arm64 MSI): no Wintun adapter.
  const ARM64_LIST = '{3A2BE0A7-EC78-4812-98DA-86595BB3234D} OpenVPN Data Channel Offload\r\n{8C1E4B0D-0000-4C2B-9C4D-2F8A1B6E7D11} OpenVPN TAP-Windows6\r\n';
  it('x64 uses the Wintun adapter, arm64 the DCO adapter', () => {
    expect(openvpnAdapterName('x64')).toBe('OpenVPN Wintun');
    expect(openvpnAdapterName('arm64')).toBe('OpenVPN Data Channel Offload');
  });
  it('the arm64 list counts as present for arm64 and missing for x64', () => {
    expect(adapterMissingIn(ARM64_LIST, openvpnAdapterName('arm64'))).toBe(false);
    expect(adapterMissingIn(ARM64_LIST, openvpnAdapterName('x64'))).toBe(true);
  });
  it('the DCO row has a label for the CLI and Diagnostics', () => {
    const lines = driverLines({ at: '', ok: true, rebootRequired: false, deps: [{ name: 'openvpn-dco', wanted: 'OpenVPN Data Channel Offload', found: 'OpenVPN Data Channel Offload', status: 'present', detail: '' }] });
    expect(lines[0]).toMatch(/^ok\s+OpenVPN DCO adapter\s+present/);
  });
});

describe('driver check timeout', () => {
  it('defaults to 60 s and takes a sane override only', () => {
    expect(driverCheckTimeoutMs({})).toBe(60_000);
    expect(driverCheckTimeoutMs({ DVPN_DRIVER_CHECK_TIMEOUT_MS: '300000' })).toBe(300_000);
    expect(driverCheckTimeoutMs({ DVPN_DRIVER_CHECK_TIMEOUT_MS: 'abc' })).toBe(60_000);
    expect(driverCheckTimeoutMs({ DVPN_DRIVER_CHECK_TIMEOUT_MS: '5' })).toBe(60_000);
    expect(driverCheckTimeoutMs({ DVPN_DRIVER_CHECK_TIMEOUT_MS: '99999999' })).toBe(60_000);
  });
});
