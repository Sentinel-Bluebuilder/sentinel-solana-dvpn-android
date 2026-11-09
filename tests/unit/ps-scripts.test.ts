// ─── PowerShell scripts parse and stay ASCII ───
// A parse error only shows once a script runs on a VM or a user's machine
// (e.g. "$var:" inside a string). Parse every .ps1 here first.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIRS = ['scripts/e2e', 'resources/scripts'];
const files = DIRS.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ps1')).map((f) => join(d, f)));

describe('PowerShell scripts', () => {
  it('finds the scripts', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('are ASCII (PowerShell 5.1 reads them as cp1252)', () => {
    const bad = files.filter((f) => /[^\x00-\x7f]/.test(readFileSync(f, 'latin1')));
    expect(bad).toEqual([]);
  });

  // The installer calls it with no arguments: a wrong default silently migrated nothing (VMs 2026-10-21).
  it('migrate-daemon-config defaults to the service home the app uses', () => {
    const s = readFileSync('resources/scripts/migrate-daemon-config.ps1', 'latin1');
    expect(s).toContain("Join-Path $env:ProgramData 'dvpnd\\client'");
    expect(readFileSync('src/main/daemon/manager.ts', 'utf8')).toContain("'C:\\\\ProgramData\\\\dvpnd\\\\client'");
  });

  it.runIf(process.platform === 'win32')('parse with no errors', () => {
    const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
    const cmd = `foreach ($f in @(${list})) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f), [ref]$null, [ref]$e); foreach ($x in $e) { "$f line $($x.Extent.StartLineNumber): $($x.Message)" } }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60_000 });
    expect(out.trim()).toBe('');
  }, 70_000);
});
