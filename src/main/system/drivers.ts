// ─── VPN drivers (F1, F17) — WireGuard, AmneziaWG, OpenVPN 2.6 + its Wintun adapter ───
// The installer runs resources/scripts/install-deps.ps1 elevated and leaves its report in
// %ProgramData%\Devnet dVPN\install-deps.json. Here the app (or CLI) re-checks the live
// state with the same script in -CheckOnly mode (no admin, installs nothing) and can
// repair with one UAC prompt. Windows only.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getHost } from '../host';
import { log } from '../logger';
import { runElevated } from './elevate';
import { resourcesDir, scriptPath, dvpndPath, restartAndroidDaemon } from '../daemon/manager';
import { isAndroid } from '../platform/android-bridge';

export type DriverStatus = 'present' | 'installed' | 'upgraded' | 'missing' | 'failed' | 'incompatible';
export interface DriverRow { name: string; wanted: string; found: string; status: DriverStatus; detail: string }
export interface DriverReport { at: string; ok: boolean; rebootRequired: boolean; deps: DriverRow[] }
export interface DriversView {
  supported: boolean;
  live: DriverReport | null;
  /** What the installer did, if it ran on this PC. */
  installer: DriverReport | null;
  error: string | null;
}

export const DRIVER_LABELS: Record<string, string> = {
  wireguard: 'WireGuard',
  amneziawg: 'AmneziaWG',
  openvpn: 'OpenVPN', // 2.6 bundled; a user's own 2.5 is kept and works (gap #68)
  'openvpn-wintun': 'OpenVPN Wintun adapter',
  'openvpn-dco': 'OpenVPN DCO adapter',
  windows: 'Windows (64-bit)',
  'deps.json': 'Bundled driver list',
  dvpnd: 'dvpnd (VPN engine)',
  v2ray: 'V2Ray',
  xray: 'Xray',
  hysteria2: 'Hysteria2',
};

// ─── Android: nothing to install. WireGuard/AmneziaWG run inside dvpnd on the VpnService TUN;
// the other engines ship in the APK and the app links them into files/bin when dvpnd starts.
const ANDROID_PROGRAMS = ['dvpnd', 'v2ray', 'xray', 'hysteria2', 'openvpn'];

/** Exported for tests: the Android report from what exists in the app's bin folder. */
export function androidReport(binDir: string, exists: (p: string) => boolean = fs.existsSync): DriverReport {
  const deps: DriverRow[] = [
    { name: 'wireguard', wanted: 'built in', found: '', status: 'present', detail: 'built into the app (wireguard-go)' },
    { name: 'amneziawg', wanted: 'built in', found: '', status: 'present', detail: 'built into the app (amneziawg-go)' },
    ...ANDROID_PROGRAMS.map((name): DriverRow => {
      const ok = exists(path.posix.join(binDir, name)); // Android paths are POSIX on any host
      return { name, wanted: 'bundled', found: '', status: ok ? 'present' : 'missing', detail: ok ? 'bundled with the app' : 'not linked yet (repair-drivers restarts the engine, which links it)' };
    }),
  ];
  return { at: new Date().toISOString(), ok: deps.every((d) => d.status === 'present'), rebootRequired: false, deps };
}

const depsDir = (): string => path.join(resourcesDir(), 'deps');
const installerReportPath = (): string => path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Devnet dVPN', 'install-deps.json');

/** Parse a report the script wrote (BOM-tolerant). Exported for tests. */
export function parseReport(text: string): DriverReport | null {
  const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Partial<DriverReport> & { deps?: DriverRow[] | DriverRow };
  if (typeof raw !== 'object' || raw === null) return null;
  // ConvertTo-Json writes a one-element array as a bare object.
  const deps = Array.isArray(raw.deps) ? raw.deps : raw.deps ? [raw.deps] : [];
  return { at: String(raw.at ?? ''), ok: raw.ok === true, rebootRequired: raw.rebootRequired === true, deps };
}

function readInstallerReport(): DriverReport | null {
  const p = installerReportPath();
  if (!fs.existsSync(p)) return null;
  try {
    return parseReport(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    log.warn('installer driver report unreadable', { err: (err as Error).message });
    return null;
  }
}

/**
 * How long the check-only run may take. 60 s by default (about 2 s on real hardware). A test VM
 * that emulates the CPU (QEMU TCG: PowerShell alone takes ~48 s to start) sets
 * DVPN_DRIVER_CHECK_TIMEOUT_MS. Exported for tests.
 */
export function driverCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.DVPN_DRIVER_CHECK_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 10_000 && v <= 900_000 ? Math.round(v) : 60_000;
}

/** Run the script in -CheckOnly mode; never installs, never prompts. */
function checkLive(): Promise<DriverReport> {
  const out = path.join(getHost().dataDir, 'drivers-check');
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env };
  delete env.PSModulePath; // a PowerShell 7 parent breaks 5.1's module autoload (elevate.ts)
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('install-deps.ps1'), '-DepsDir', depsDir(), '-OutDir', out, '-CheckOnly'],
      { timeout: driverCheckTimeoutMs(), windowsHide: true, env }, (err) => {
        // Exit 2 = "something missing": the report is still written and is the answer.
        const file = path.join(out, 'install-deps.json');
        if (fs.existsSync(file)) {
          try {
            const r = parseReport(fs.readFileSync(file, 'utf8'));
            if (r) { resolve(r); return; }
          } catch (parseErr) {
            reject(new Error(`driver check report unreadable: ${(parseErr as Error).message}`));
            return;
          }
        }
        reject(new Error(err ? `driver check failed: ${err.message.slice(0, 200)}` : 'driver check wrote no report'));
      });
  });
}

export async function driversStatus(): Promise<DriversView> {
  if (isAndroid()) return { supported: true, live: androidReport(path.dirname(dvpndPath())), installer: null, error: null };
  if (process.platform !== 'win32') return { supported: false, live: null, installer: null, error: null };
  const installer = readInstallerReport();
  try {
    return { supported: true, live: await checkLive(), installer, error: null };
  } catch (err) {
    log.warn('driver check', { err: (err as Error).message });
    return { supported: true, live: null, installer, error: (err as Error).message };
  }
}

/** Install or repair every missing driver (one administrator prompt). */
export async function repairDrivers(): Promise<{ ok: boolean; error?: string; view: DriversView }> {
  if (isAndroid()) {
    if (!(await driversStatus()).live?.ok) {
      const r = await restartAndroidDaemon();
      if (!r.ok) return { ok: false, error: r.error, view: await driversStatus() };
    }
    const view = await driversStatus();
    return view.live?.ok ? { ok: true, view } : { ok: false, error: 'Some parts of the app are missing. Reinstall the app.', view };
  }
  if (process.platform !== 'win32') return { ok: false, error: 'Drivers are installed by the Windows app only.', view: await driversStatus() };
  const r = await runElevated(scriptPath('install-deps.ps1'), { DepsDir: depsDir() }, 600_000);
  const view = await driversStatus();
  if (r.status === 'ok') return { ok: true, view };
  return { ok: false, error: r.status === 'cancelled' ? r.detail : `Some drivers could not be installed: ${r.detail}`, view };
}

/** Re-create only dvpnd's OpenVPN adapter (one admin step), then check it is there. */
export async function recreateOpenvpnAdapter(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== 'win32') return { ok: false, detail: 'Windows only' };
  log.info('openvpn adapter missing; re-creating it');
  // 180 s: the first Wintun driver install on a fresh PC ran past 60 s (VM ui-win-2 2026-10-22).
  const r = await runElevated(scriptPath('openvpn-adapter.ps1'), {}, 180_000);
  if (r.status !== 'ok') return { ok: false, detail: r.detail };
  if (await openvpnAdapterMissing()) return { ok: false, detail: 'still missing after tapctl create' };
  return { ok: true, detail: r.detail };
}

/** One line per driver, for the CLI and the in-app terminal. */
export function driverLines(r: DriverReport): string[] {
  return r.deps.map((d) => {
    const mark = d.status === 'failed' || d.status === 'incompatible' ? 'FAIL' : d.status === 'missing' ? 'miss' : 'ok  ';
    const ver = d.found ? ` ${d.found}` : '';
    return `${mark}  ${(DRIVER_LABELS[d.name] ?? d.name).padEnd(24)} ${d.status}${ver}${d.detail ? `  (${d.detail})` : ''}`;
  });
}

/**
 * The adapter dvpnd's OpenVPN uses. x64: Wintun. ARM64: the official arm64 OpenVPN MSI has no
 * Wintun driver, so dvpnd uses ovpn-dco and its DCO adapter (UPSTREAM-GAPS #83). The app is a
 * native build per CPU, so process.arch is the machine's CPU. Exported for tests.
 */
export function openvpnAdapterName(arch: string = process.arch): string {
  return arch === 'arm64' ? 'OpenVPN Data Channel Offload' : 'OpenVPN Wintun';
}

/** true when tapctl's list does not show that adapter. Exported for tests. */
export function adapterMissingIn(tapctlList: string, name: string): boolean {
  return !tapctlList.includes(name);
}

/**
 * OpenVPN 2.6 needs its adapter, and on x64 an AmneziaWG tunnel start deletes the Wintun one
 * (AmneziaWG's Wintun driver reset; UPSTREAM-GAPS #27). Checked before paying for an OpenVPN
 * session. true = known missing; false = present or unknown (never block on a failed check).
 */
export function openvpnAdapterMissing(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const tapctl = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'OpenVPN', 'bin', 'tapctl.exe');
  if (!fs.existsSync(tapctl)) return Promise.resolve(false); // OpenVPN itself missing: the driver check says so
  return new Promise((resolve) => {
    execFile(tapctl, ['list'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) { log.warn('tapctl list failed; not blocking the connect', { err: err.message }); resolve(false); return; }
      resolve(adapterMissingIn(String(stdout), openvpnAdapterName()));
    });
  });
}
