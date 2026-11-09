// ─── devnet-dvpn CLI ───
// Same services as the desktop app (src/main, Electron-free), different host.
//   node out/cli/devnet-dvpn.cjs <command> [...] [--json] [--yes]
// Exit codes: 0 ok · 1 error · 2 needs --yes · 3 usage.
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, UsageError } from './args';
import { COMMANDS, NeedsConfirm, type Out } from './commands';
import { CATALOGUE, GROUP_LABEL, entryFor, unknownFlags } from './catalogue';
import { cliKeyStore } from './keystore';
import { initRuntime, defaultDataDir } from '../main/runtime';
import { startDaemonLink, stopDaemonLink, daemonReady } from '../main/daemon/manager';
import { redact, redactUrls, log } from '../main/logger';
import '../main/ks-title-wire';
import { rpcUnavailableCopy } from '../core/chain/rpc';
import { consoleText } from './console-text';

function resourcesDir(): string {
  if (process.env.DVPN_RESOURCES) return process.env.DVPN_RESOURCES;
  // out/cli/devnet-dvpn.cjs → <repo>/resources ; packaged: <install>/resources
  const candidates = [
    path.resolve(__dirname, '..', '..', 'resources'),
    path.join(path.dirname(process.execPath), 'resources', 'resources'), // packaged: extraResources
    path.resolve(path.dirname(process.execPath), 'resources'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'daemon.proto'))) ?? candidates[0];
}

function usage(): string {
  const rows: string[] = [];
  for (const [g, label] of Object.entries(GROUP_LABEL)) {
    rows.push(label);
    for (const e of CATALOGUE.filter((x) => x.group === g)) rows.push(`  ${e.usage}
      ${e.summary}`);
  }
  return [
    'devnet-dvpn — pure-P2P dVPN on the Sentinel Solana devnet',
    '',
    'Usage: devnet-dvpn <command> [args] [--json] [--yes] [--verbose]',
    '',
    ...rows,
    '',
    'Env: DVPN_KEYFILE (use a key file in place), DVPN_DATA_DIR, DVPN_DAEMON_PIPE, DVPN_DAEMON_HOME, DVPN_NO_BRIDGE=1',
  ].join('\n');
}

async function main(): Promise<number> {
  process.env.NODE_ENV ??= 'production';
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags.json === true;
  const out: Out = {
    json,
    print(human, data) {
      // RPC URLs carry provider API keys in their query string: never print them.
      if (json) {
        if (data !== undefined) process.stdout.write(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? redactUrls(v) : v)) + '\n');
      } else process.stdout.write(consoleText(redactUrls(human)) + '\n');
    },
  };
  const name = args._[0];
  if (!name || args.flags.help === true || name === 'help') { process.stdout.write(consoleText(usage()) + '\n'); return 0; }
  const cmd = COMMANDS[name];
  if (!cmd) { process.stderr.write(consoleText(`unknown command: ${name}\n\n${usage()}\n`, process.stderr)); return 3; }
  const unknown = unknownFlags(args._, args.flags);
  if (unknown.length) {
    const e = entryFor(args._.join(' '));
    process.stderr.write(consoleText(redactUrls(`unknown option ${unknown.map((k) => `--${k}`).join(', ')} for "${e?.cmd}". Usage: ${e?.usage}\n`), process.stderr));
    return 3;
  }

  const dataDir = defaultDataDir();
  const keyfile = typeof args.flags.keyfile === 'string' ? args.flags.keyfile : process.env.DVPN_KEYFILE;
  initRuntime({ name: 'cli', resourcesDir: resourcesDir(), dataDir, keyStore: cliKeyStore(dataDir, keyfile), emit: () => undefined });
  // Internal diagnostics ("[rpc] benched … fetch failed") go to the log, not the terminal: the user
  // gets one plain "Error: …" line. --verbose shows them too (vm-installer-test offline, 2026-10-22).
  if (args.flags.verbose !== true) {
    console.warn = (...a: unknown[]): void => log.warn(a.map(String).join(' '));
    console.error = (...a: unknown[]): void => log.error(a.map(String).join(' '));
  }
  if (cmd.needsDaemon) {
    startDaemonLink();
    await daemonReady();
  }
  try {
    await cmd.run(args, out);
    return 0;
  } catch (err) {
    if (err instanceof NeedsConfirm) return 2;
    // Usage errors echo what was typed: a URL there can carry an API key (the macOS app fuzz: poll reset <url>).
    if (err instanceof UsageError) { process.stderr.write(consoleText(`${redactUrls(err.message)}\n`, process.stderr)); return 3; }
    const rpc = rpcUnavailableCopy(err);
    if (rpc) {
      log.warn('cli command failed on every RPC endpoint', { command: name, err: (err as Error).message });
      err = Object.assign(new Error(rpc.message), { code: 'rpc-unavailable', action: rpc.action });
    }
    const e = err as Error & { code?: string; action?: string | null };
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: redact(e.message), code: e.code ?? null, action: e.action ?? null }) + '\n');
    else process.stderr.write(consoleText(`Error: ${redact(e.message)}${e.action ? `\n→ ${e.action}` : ''}\n`, process.stderr));
    return 1;
  } finally {
    if (cmd.needsDaemon) stopDaemonLink();
  }
}

// Let grpc-js finish closing its handles first; exiting mid-close trips a libuv assertion on Windows.
main().then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 400).unref(); }, (err) => { process.stderr.write(`fatal: ${(err as Error).stack}\n`); process.exit(1); });
