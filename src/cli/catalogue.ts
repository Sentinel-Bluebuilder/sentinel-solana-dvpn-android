// ─── CLI catalogue: the one description of every command ───
// Used by `devnet-dvpn help`, the in-app CLI screen and docs/CLI.md
// (`npm run docs:cli`). tests/unit/cli-map.test.ts fails when a command in
// COMMANDS, or an app function in CLI_FOR_IPC, is missing here.
// No imports: the renderer loads this file too.

export type CliGroup = 'overview' | 'wallet' | 'device' | 'service' | 'servers' | 'connect' | 'plans' | 'money' | 'testing' | 'quality' | 'settings';

export const GROUP_LABEL: Record<CliGroup, string> = {
  overview: 'Overview',
  wallet: 'Wallet',
  device: 'Device + spending permission',
  service: 'VPN service (dvpnd)',
  servers: 'Servers',
  connect: 'Connect + sessions',
  plans: 'Plans + subscriptions',
  money: 'Deposits, refunds, history',
  testing: 'Node testing',
  quality: 'Diagnostics',
  settings: 'Settings + RPC',
};

export interface CliEntry {
  /** Command and subcommand, e.g. `wallet send`. */
  cmd: string;
  group: CliGroup;
  usage: string;
  summary: string;
  /** Signs a transaction or changes the computer: asks for --yes first. */
  confirm?: true;
  /** Not run inside the app terminal (secrets on screen, or a stream that never ends). */
  appBlocked?: string;
}

export const CATALOGUE: CliEntry[] = [
  { cmd: 'version', group: 'overview', usage: 'version', summary: 'App version, network, program and mint.' },
  { cmd: 'status', group: 'overview', usage: 'status', summary: 'Wallet, device, service and session at a glance.' },
  { cmd: 'logs', group: 'overview', usage: 'logs [--lines N]', summary: 'The app log, secrets removed.' },

  { cmd: 'wallet show', group: 'wallet', usage: 'wallet show', summary: 'Address and balances (SOL, tDVPN, refundable, approved).' },
  { cmd: 'wallet receive', group: 'wallet', usage: 'wallet receive', summary: 'Address with a QR code.' },
  { cmd: 'wallet create', group: 'wallet', usage: 'wallet create --yes', summary: 'New 24-word wallet; prints the phrase once.', confirm: true, appBlocked: 'The recovery phrase is shown only on the Wallet / setup screen.' },
  { cmd: 'wallet import', group: 'wallet', usage: 'wallet import <file|-> --yes', summary: 'Import a phrase, key file or base58 secret.', confirm: true, appBlocked: 'Secrets are typed only on the Wallet / setup screen.' },
  { cmd: 'wallet send', group: 'wallet', usage: 'wallet send --to <address> [--tdvpn N] [--sol N] --yes', summary: 'Send tDVPN or SOL.', confirm: true },
  { cmd: 'wallet logout', group: 'wallet', usage: 'wallet logout --yes', summary: 'Remove the wallet from this device.', confirm: true },

  { cmd: 'device show', group: 'device', usage: 'device show', summary: 'Device key, spending limit, token permission, device SOL.' },
  { cmd: 'device plan', group: 'device', usage: 'device plan [--allowance N]', summary: 'What setup would sign (no transaction).' },
  { cmd: 'device setup', group: 'device', usage: 'device setup [--allowance N] --yes', summary: 'Approve tokens, give the device a spending permission (grant), send it fee SOL.', confirm: true },
  { cmd: 'device register', group: 'device', usage: 'device register [pubkey] [--home <dir>]', summary: 'Adopt an existing service device key.' },
  { cmd: 'device revoke', group: 'device', usage: 'device revoke [--device D] --yes', summary: "Remove this device's spending permission (other devices keep theirs; the shared token approval stays). --device D removes another device of this wallet, e.g. a computer that is gone.", confirm: true },

  { cmd: 'daemon version', group: 'service', usage: 'daemon version', summary: 'Service build and network.' },
  { cmd: 'daemon doctor', group: 'service', usage: 'daemon doctor', summary: 'Service health checks (ok / warn / fail).' },
  { cmd: 'daemon dns-check', group: 'service', usage: 'daemon dns-check [--dns handshake|cloudflare|ip,ip]', summary: 'Ask each DNS server one question from this computer; exit 1 when none answers (same check as the Settings DNS picker).' },
  { cmd: 'daemon drivers', group: 'service', usage: 'daemon drivers', summary: 'WireGuard, AmneziaWG, OpenVPN 2.6 + adapter: ready or missing (no admin).' },
  { cmd: 'daemon repair-drivers', group: 'service', usage: 'daemon repair-drivers --yes', summary: 'Install or repair missing VPN drivers (Windows: one admin prompt; Android: re-links the bundled protocol programs).', confirm: true },
  { cmd: 'daemon init', group: 'service', usage: 'daemon init', summary: 'Create the device key (no admin needed).' },
  { cmd: 'daemon install', group: 'service', usage: 'daemon install --yes', summary: 'Install and start the service (Windows: one admin prompt; Android: the engine runs inside the app, nothing to install).', confirm: true },
  { cmd: 'daemon settings', group: 'service', usage: 'daemon settings', summary: 'Kill switch, DNS, LAN, RPC (key hidden).' },
  { cmd: 'daemon set', group: 'service', usage: 'daemon set [--kill-switch off|on|persist] [--dns handshake|cloudflare|ip,ip] [--dns-mode netsh|vpn|none] [--allow-lan true|false] [--whole-device true|false] [--split-mode off|include|exclude] [--split-apps "C:\path\app.exe;..."|none] [--split-routes IP-or-CIDR,...|none] [--basis per_gb|per_hour] [--escrow tDVPN] [--prepay-mb N] [--prepay-minutes N] [--rpc URL] [--rpc-ws URL] --yes', summary: 'Change service settings and restart it (Windows: admin prompt; Android: vpn is the DNS mode, and --whole-device / --split-* are desktop only: use split set / split routes).', confirm: true },
  { cmd: 'daemon restore-network', group: 'service', usage: 'daemon restore-network', summary: 'End any session, release kill switch and proxy.' },

  { cmd: 'nodes list', group: 'servers', usage: 'nodes list [--online] [--country DE] [--protocol wireguard] [--sort price] [--no-probe]', summary: 'Every listed server, checked live.' },
  { cmd: 'nodes show', group: 'servers', usage: 'nodes show <node>', summary: 'One server: prices, protocols, signature checks.' },
  { cmd: 'nodes fav', group: 'servers', usage: 'nodes fav <node>', summary: 'Add or remove a favourite.' },
  { cmd: 'nodes recent', group: 'servers', usage: 'nodes recent', summary: 'Servers you used most recently.' },
  { cmd: 'cost', group: 'servers', usage: 'cost <node> [--basis per_gb|per_hour] [--units N]', summary: 'Exact deposit before you connect.' },

  { cmd: 'connect', group: 'connect', usage: 'connect <node> [--basis per_gb|per_hour] [--units N] [--plan <subscription>] [--switch] --yes', summary: 'Pay a deposit (or use a plan) and connect.', confirm: true },
  { cmd: 'connect --follow', group: 'connect', usage: 'connect <node> … --follow', summary: 'Connect, then print usage every 5 s.', confirm: true, appBlocked: 'The Connect screen shows live usage.' },
  { cmd: 'disconnect', group: 'connect', usage: 'disconnect', summary: 'Stop the session; the deposit settles later.' },
  { cmd: 'sessions', group: 'connect', usage: 'sessions', summary: 'Sessions the service holds.' },
  { cmd: 'tickets', group: 'connect', usage: 'tickets', summary: 'Plan access tickets the service holds.' },
  { cmd: 'proxy status', group: 'connect', usage: 'proxy status', summary: 'SOCKS endpoint and system-proxy state.' },
  { cmd: 'proxy on', group: 'connect', usage: 'proxy on --yes', summary: 'Point Windows apps at the session SOCKS proxy.', confirm: true },
  { cmd: 'proxy browser', group: 'connect', usage: 'proxy browser [--browser edge|chrome] [--url U]', summary: 'Open Edge or Chrome in its own profile through the session (only that window uses the VPN).' },
  { cmd: 'proxy off', group: 'connect', usage: 'proxy off', summary: 'Restore your own proxy settings.' },
  { cmd: 'split status', group: 'connect', usage: 'split status', summary: 'Desktop: split tunnelling mode, chosen apps and addresses, and what each protocol does with them.' },
  { cmd: 'split show', group: 'connect', usage: 'split show', summary: 'Android: which apps use the VPN (all, only these, all except these).' },
  { cmd: 'split apps', group: 'connect', usage: 'split apps [--search TEXT]', summary: 'Apps you can choose: Android, apps with a launcher icon and their package names; desktop, installed and running apps (full paths for daemon set --split-apps).' },
  { cmd: 'split set', group: 'connect', usage: 'split set all|include|exclude [package…]', summary: 'Android: choose apps for the VPN, every protocol. Applies from the next connect.' },
  { cmd: 'split routes', group: 'connect', usage: 'split routes all|include|exclude [address|network…]', summary: 'Android: choose addresses for the VPN (like 10.0.0.0/8), every protocol. Applies from the next connect.' },

  { cmd: 'plans list', group: 'plans', usage: 'plans list', summary: 'Every plan on the network.' },
  { cmd: 'plans roster', group: 'plans', usage: 'plans roster <plan>', summary: 'Servers on a plan, live or down.' },
  { cmd: 'plans subscribe', group: 'plans', usage: 'plans subscribe <plan> --yes', summary: 'Buy a plan (no refund).', confirm: true },
  { cmd: 'plans subscriptions', group: 'plans', usage: 'plans subscriptions', summary: 'Your subscriptions and time left.' },
  { cmd: 'plans close', group: 'plans', usage: 'plans close <subscription> --yes', summary: 'End a subscription (rent back, no refund).', confirm: true },

  { cmd: 'channels', group: 'money', usage: 'channels', summary: 'Deposits the service holds.' },
  { cmd: 'channels fund', group: 'money', usage: 'channels fund <channel> --tdvpn N --yes', summary: 'Top up a deposit that is still open.', confirm: true },
  { cmd: 'settle list', group: 'money', usage: 'settle list [--device D]', summary: 'Deposits waiting to be refunded. --device D lists the deposits of a removed device.' },
  { cmd: 'settle run', group: 'money', usage: 'settle run [--channel C] [--device D] --yes', summary: 'Start / finish closing deposits. --device D settles the deposits of a removed device.', confirm: true },
  { cmd: 'settle withdraw', group: 'money', usage: 'settle withdraw --yes', summary: 'Move refunds back to the wallet.', confirm: true },
  { cmd: 'history list', group: 'money', usage: 'history list', summary: 'Every session with data and spend.' },
  { cmd: 'history summary', group: 'money', usage: 'history summary', summary: 'Totals, last 30 days, top servers.' },
  { cmd: 'history export', group: 'money', usage: 'history export [--out file.csv]', summary: 'Session history as CSV.' },

  { cmd: 'test plan', group: 'testing', usage: 'test plan <node…> | --online', summary: 'Most a test run could lock in deposits (no transaction).' },
  { cmd: 'test run', group: 'testing', usage: 'test run <node…> | --online [--max-nodes N] [--max-spend N] --yes', summary: 'Real session on each server, one at a time: connect time, exit IP, DNS, speed → FAST / SLOW / FAIL. Test deposits are closed after.', confirm: true },
  { cmd: 'test stop', group: 'testing', usage: 'test stop', summary: 'Stop a running test at its next step (the server being tested is disconnected first; it shows as CANCELLED). Ctrl-C does the same in the terminal running it.' },
  { cmd: 'test history', group: 'testing', usage: 'test history', summary: 'Past test runs with FAST / SLOW / FAIL counts.' },
  { cmd: 'test show', group: 'testing', usage: 'test show [run-id] [--compare]', summary: 'One run per server (latest if no id); --compare shows what changed since the run before.' },
  { cmd: 'test export', group: 'testing', usage: 'test export [run-id] [--out file.json]', summary: 'A run as JSON.' },

  { cmd: 'quality ip', group: 'quality', usage: 'quality ip', summary: 'Public IP as websites see it.' },
  { cmd: 'quality speed', group: 'quality', usage: 'quality speed', summary: 'Download speed test.' },

  { cmd: 'rpc state', group: 'settings', usage: 'rpc state', summary: 'Endpoint in use, slot, latency (key hidden).' },
  { cmd: 'rpc set', group: 'settings', usage: 'rpc set <url> [url…]', summary: 'Your own Solana RPC endpoints (https).' },
  { cmd: 'poll show', group: 'settings', usage: 'poll show', summary: 'Background refresh cadences: current, default and allowed range for each job.' },
  { cmd: 'poll set', group: 'settings', usage: 'poll set <job>=<seconds> …', summary: 'Change how often a background job runs (wallet, nodes, plans, subscriptions, settlements, ip, dns, rpc, session).' },
  { cmd: 'poll reset', group: 'settings', usage: 'poll reset [job…]', summary: 'Put cadences back to their defaults.' },
  { cmd: 'poll run', group: 'settings', usage: 'poll run [job…]', summary: 'Run background jobs once now and show how long each took.' },
  { cmd: 'poll watch', group: 'settings', usage: 'poll watch [--seconds N] [--hidden]', summary: 'Run the real scheduler for N seconds and check every job kept its cadence (exit 1 if not).' },
  { cmd: 'settings get', group: 'settings', usage: 'settings get', summary: 'App settings.' },
  { cmd: 'settings set', group: 'settings', usage: 'settings set key=value …', summary: 'Change app settings (unknown keys refused).' },
  { cmd: 'settings reset', group: 'settings', usage: 'settings reset --yes', summary: 'Restore default app settings; favourites and RPC endpoints are kept.', confirm: true },
];

/** The catalogue entry for a command line, longest match first (`wallet send` before `wallet`). */
export function entryFor(line: string): CliEntry | null {
  const words = line.trim().split(/\s+/);
  const two = words.slice(0, 2).join(' ');
  return CATALOGUE.find((e) => e.cmd === two) ?? CATALOGUE.find((e) => e.cmd === words[0]) ?? null;
}

/** docs/CLI.md body. */
export function catalogueMarkdown(): string {
  const out: string[] = [];
  for (const g of Object.keys(GROUP_LABEL) as CliGroup[]) {
    const rows = CATALOGUE.filter((e) => e.group === g);
    if (!rows.length) continue;
    out.push(`### ${GROUP_LABEL[g]}`, '', '| Command | What it does | Asks for `--yes` |', '|---|---|---|');
    for (const e of rows) out.push(`| \`${e.usage.replace(/\|/g, '\\|')}\` | ${e.summary}${e.appBlocked ? ` *(CLI only: ${e.appBlocked})*` : ''} | ${e.confirm ? 'yes' : ''} |`);
    out.push('');
  }
  return out.join('\n');
}

// ─── Unknown flags are refused (the macOS app rig 2: `daemon set --dns-preset quad9 --yes` said "Applied
// and restarted" and changed nothing; the real flag is --dns) ───
/** Flags every command takes. */
export const GLOBAL_FLAGS: readonly string[] = ['help', 'json', 'keyfile', 'verbose', 'yes'];

/** Flags given that this command does not take (none when the command is not in the catalogue).
 *  Variant entries of the same command (`connect --follow`) add their flags to it. */
export function unknownFlags(positionals: string[], flags: Record<string, unknown>): string[] {
  const e = entryFor(positionals.join(' '));
  if (!e) return [];
  const usages = CATALOGUE.filter((x) => x.cmd === e.cmd || x.cmd.startsWith(`${e.cmd} --`)).map((x) => x.usage);
  const known = new Set([...GLOBAL_FLAGS, ...usages.flatMap((u) => (u.match(/--[a-z0-9-]+/g) ?? []).map((x) => x.slice(2)))]);
  return Object.keys(flags).filter((k) => !known.has(k));
}
