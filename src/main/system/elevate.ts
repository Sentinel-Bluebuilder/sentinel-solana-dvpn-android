// ─── One UAC prompt per privileged step (D4, F1.5) ───
// Runs a bundled PowerShell script elevated via Start-Process -Verb RunAs. Only
// file paths and validated tokens go on the command line — never config text
// (M5.3 #8). The script reports through a JSON result file we read back.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { log } from '../logger';

const SAFE_ARG = /^[A-Za-z0-9 _.:\\/-]+$/;

export interface ElevatedResult { status: 'ok' | 'error' | 'cancelled'; detail: string; [k: string]: unknown }

/** Double-quoted for the elevated command line. SAFE_ARG has no quotes, so nothing can break out. */
function dq(s: string): string {
  if (!SAFE_ARG.test(s)) throw new Error(`refusing unsafe argument for elevated step: ${s}`); // copy:internal
  return `"${s}"`;
}

/** The elevated process's command line (exported for tests). */
export function elevatedArgLine(script: string, args: Record<string, string>): string {
  const named = Object.entries(args).map(([k, v]) => {
    if (!/^[A-Za-z]+$/.test(k)) throw new Error(`bad parameter name ${k}`); // copy:internal
    return `-${k} ${dq(v)}`;
  });
  return ['-NoProfile', '-ExecutionPolicy Bypass', `-File ${dq(script)}`, ...named].join(' ');
}

/**
 * The unelevated PowerShell that starts the step. Already an administrator (an elevated
 * terminal, an SSH session, the installer) → run it directly: no prompt, and no RunAs,
 * which fails in a session without a desktop. Otherwise one UAC prompt.
 * The arg line is single-quoted; it holds no single quotes (SAFE_ARG). Exported for tests.
 */
export function elevatedOuterCommand(line: string): string {
  return [
    `$a = '${line}'`,
    '$admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'if ($admin) { $p = Start-Process -FilePath powershell.exe -WindowStyle Hidden -Wait -PassThru -ArgumentList $a }',
    'else { $p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $a }',
    'exit $p.ExitCode',
  ].join('; ');
}

/**
 * What to report when the step wrote no result file. A step cut off by our time limit is not a
 * declined prompt: saying so sent a user hunting for a prompt that never existed (VM ui-win-2
 * 2026-10-22: the first OpenVPN adapter install ran past 60 s with no prompt at all).
 * Exported for tests.
 */
export function noResultOutcome(timedOut: boolean, timeoutMs: number): ElevatedResult {
  if (timedOut) return { status: 'error', detail: `The admin step did not finish within ${Math.round(timeoutMs / 1000)} s. Try again; a first-time driver setup can be slow.` };
  return { status: 'cancelled', detail: 'The Windows permission prompt was declined or closed.' };
}

/** Run `script` elevated with named args; resolves with its result JSON. */
/**
 * How long an admin step may take. 120 s by default. A test VM that emulates the CPU (QEMU TCG
 * ARM64: each CLI call ~140 s) sets DVPN_ELEVATE_TIMEOUT_MS, like DVPN_DRIVER_CHECK_TIMEOUT_MS.
 */
export function elevateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.DVPN_ELEVATE_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 10_000 && v <= 900_000 ? Math.round(v) : 120_000;
}

/**
 * L6: a step cut off by our time limit may still have finished its work (the helper keeps running
 * with admin rights after we kill the launcher). `verify` checks the real outcome; when it returns a
 * result, that replaces the timeout error. Exported for tests.
 */
export async function settleTimedOut(r: ElevatedResult, timedOut: boolean, verify?: () => Promise<ElevatedResult | null>): Promise<ElevatedResult> {
  if (!timedOut || r.status !== 'error' || !verify) return r;
  try {
    return (await verify()) ?? r;
  } catch (err) {
    log.warn('post-timeout verification failed', { err: String(err) });
    return r;
  }
}

export async function runElevated(script: string, args: Record<string, string>, timeoutMs = elevateTimeoutMs(), verify?: () => Promise<ElevatedResult | null>): Promise<ElevatedResult> {
  const result = path.join(os.tmpdir(), `devnet-dvpn-${randomBytes(6).toString('hex')}.json`);
  const line = elevatedArgLine(script, { ...args, Result: result });
  const outer = elevatedOuterCommand(line);
  log.info('elevated step', { script: path.basename(script) });
  // Started from a PowerShell 7 window, PSModulePath points at 7's modules; Windows
  // PowerShell 5.1 then fails to load Get-Service / Get-FileHash and our scripts misread
  // the empty results. Drop it so 5.1 rebuilds its own default.
  const env = { ...process.env };
  delete env.PSModulePath;
  let timedOut = false;
  await new Promise<void>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { timeout: timeoutMs, windowsHide: true, env }, (err, _stdout, stderr) => {
      if (err) {
        timedOut = Boolean((err as { killed?: boolean }).killed);
        log.warn('elevated step returned an error', { script: path.basename(script), timedOut, timeoutMs, code: (err as NodeJS.ErrnoException).code, stderr: String(stderr).slice(0, 400) });
      }
      resolve();
    });
  });
  if (!fs.existsSync(result)) return await settleTimedOut(noResultOutcome(timedOut, timeoutMs), timedOut, verify);
  try {
    return JSON.parse(fs.readFileSync(result, 'utf8').replace(/^﻿/, '')) as ElevatedResult;
  } finally {
    fs.rmSync(result, { force: true });
  }
}
