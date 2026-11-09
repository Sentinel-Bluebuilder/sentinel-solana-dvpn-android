// ─── In-app CLI (the CLI screen) ───
// Runs a command line through the SAME command table as the standalone CLI,
// inside the running app (its wallet, service link and state). Rules:
//   · secrets never reach the renderer: wallet create/import are CLI-only (F2.5)
//   · a spend or system change still prints what it would do until --yes is typed
//   · one command at a time; output is redacted like the CLI's
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs, UsageError } from '../../cli/args';
import { COMMANDS, NeedsConfirm, type Out } from '../../cli/commands';
import { CATALOGUE, entryFor, GROUP_LABEL } from '../../cli/catalogue';
import { redact, redactUrls, log } from '../logger';
import { getHost } from '../host';

export interface CliRun { ok: boolean; text: string; needsConfirm?: boolean; code?: number }

let busy = false;

/** Split a command line into words; "double" and 'single' quotes group. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function helpText(): string {
  const rows: string[] = [];
  for (const [g, label] of Object.entries(GROUP_LABEL)) {
    const cmds = CATALOGUE.filter((e) => e.group === g && !e.appBlocked);
    if (!cmds.length) continue;
    rows.push(label);
    for (const c of cmds) rows.push(`  ${c.usage}\n      ${c.summary}`);
  }
  return [...rows, '', 'Built in: help · clear', 'Add --json for machine output. Spending asks for --yes.'].join('\n');
}

export async function runCliLine(line: string): Promise<CliRun> {
  const words = tokenize(line.trim());
  if (!words.length) return { ok: true, text: '' };
  if (words[0] === 'devnet-dvpn') words.shift();
  if (!words.length || words[0] === 'help') return { ok: true, text: helpText() };
  const cmd = COMMANDS[words[0]];
  if (!cmd) return { ok: false, text: `Unknown command "${words[0]}". Type help.`, code: 3 };
  const args = parseArgs(words);
  const entry = entryFor(words.join(' '));
  if (entry?.appBlocked) return { ok: false, text: `Not available in the app terminal: ${entry.appBlocked}`, code: 3 };
  if (args.flags.follow) return { ok: false, text: 'Not available in the app terminal: --follow (the Connect screen shows live usage).', code: 3 };
  if (busy) return { ok: false, text: 'Another command is still running.', code: 1 };
  busy = true;
  const lines: string[] = [];
  const json = args.flags.json === true;
  const out: Out = {
    json,
    print(human, data) {
      if (json) { if (data !== undefined) lines.push(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? redactUrls(v) : v), 2)); }
      else lines.push(redactUrls(human));
    },
  };
  try {
    await cmd.run(args, out);
    return { ok: true, text: lines.join('\n'), code: 0 };
  } catch (err) {
    if (err instanceof NeedsConfirm) return { ok: true, needsConfirm: true, text: lines.join('\n'), code: 2 };
    if (err instanceof UsageError) return { ok: false, text: `${err.message}${entry ? `\nUsage: ${entry.usage}` : ''}`, code: 3 };
    const e = err as Error & { action?: string | null };
    log.warn('cli line failed', { cmd: words[0], err: redact(e.message) });
    return { ok: false, text: [...lines, `Error: ${redact(e.message)}${e.action ? `\n→ ${e.action}` : ''}`].join('\n'), code: 1 };
  } finally {
    busy = false;
  }
}

/** A PowerShell window with `devnet-dvpn` bound to this app's data folder (Windows). */
export function openPowerShell(execPath: string, cliPath: string, resourcesDir: string): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') return { ok: false, error: 'PowerShell is Windows-only; run the CLI from your terminal.' };
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `$env:DVPN_DATA_DIR = ${q(getHost().dataDir)}`,
    `$env:DVPN_RESOURCES = ${q(resourcesDir)}`,
    // electron.exe is a GUI-subsystem binary: its output shows only when piped.
    `function global:devnet-dvpn { $env:ELECTRON_RUN_AS_NODE = '1'; $env:NODE_NO_WARNINGS = '1'; & ${q(execPath)} ${q(cliPath)} @args 2>&1 | ForEach-Object { "$_" }; $global:LASTEXITCODE = $LASTEXITCODE; Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:NODE_NO_WARNINGS }`,
    "Write-Host 'devnet-dvpn is ready. Try: devnet-dvpn help' -ForegroundColor Green",
  ].join('; ');
  try {
    const p = spawn('cmd.exe', ['/c', 'start', '"Devnet dVPN CLI"', 'powershell.exe', '-NoExit', '-NoProfile', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(cliPath),
    });
    p.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
