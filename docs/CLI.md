# CLI — every app function from a terminal

The desktop app and the CLI call the same services (`src/main`, Electron-free).
Nothing the app can do is missing from the CLI: `tests/unit/cli-map.test.ts` fails
when an app function (IPC channel) has no command, when a command is undocumented
here, or when this file is out of date.

## Three ways to run it

| Where | How | Notes |
|---|---|---|
| In the app | **CLI** in the sidebar | Same commands, run inside the running app (shares its wallet, service link and state). A recovery phrase or secret key is never shown or typed here; spending still needs `--yes`. |
| PowerShell from the app | CLI screen → **Open in PowerShell** | Opens a shell with `devnet-dvpn` ready, using the app's data folder. |
| Any terminal | `node out/cli/devnet-dvpn.cjs <command>` (dev) · `devnet-dvpn <command>` (installed) | Build with `npm run build:cli`. |

Flags on every command: `--json` (machine output, one JSON line) · `--yes` (do it; without
it a spend or system change only prints what it would do) · `--keyfile <path>` (use a key file
in place, never copied).

Exit codes: `0` ok · `1` error · `2` needs `--yes` · `3` usage.

Environment: `DVPN_DATA_DIR`, `DVPN_KEYFILE`, `DVPN_DAEMON_PIPE`, `DVPN_DAEMON_HOME`,
`DVPN_NO_BRIDGE=1`. Test rigs only: `DVPN_DAEMON_TARGET`, `DVPN_NODE_API_OVERRIDES`,
`DVPN_PROVIDER_API_OVERRIDES` (see `scripts/e2e/rig-env.sh`, `box-rig.sh env`).

Output never contains RPC API keys (URL query strings are redacted) or secrets.

## Commands

Generated from `src/cli/catalogue.ts` — edit that file, then `npm run docs:cli`.

<!-- cli-catalogue:start -->
### Overview

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `version` | App version, network, program and mint. |  |
| `status` | Wallet, device, service and session at a glance. |  |
| `logs [--lines N]` | The app log, secrets removed. |  |

### Wallet

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `wallet show` | Address and balances (SOL, tDVPN, refundable, approved). |  |
| `wallet receive` | Address with a QR code. |  |
| `wallet create --yes` | New 24-word wallet; prints the phrase once. *(CLI only: The recovery phrase is shown only on the Wallet / setup screen.)* | yes |
| `wallet import <file\|-> --yes` | Import a phrase, key file or base58 secret. *(CLI only: Secrets are typed only on the Wallet / setup screen.)* | yes |
| `wallet send --to <address> [--tdvpn N] [--sol N] --yes` | Send tDVPN or SOL. | yes |
| `wallet logout --yes` | Remove the wallet from this device. | yes |

### Device + spending permission

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `device show` | Device key, spending limit, token permission, device SOL. |  |
| `device plan [--allowance N]` | What setup would sign (no transaction). |  |
| `device setup [--allowance N] --yes` | Approve tokens, give the device a spending permission (grant), send it fee SOL. | yes |
| `device register [pubkey] [--home <dir>]` | Adopt an existing service device key. |  |
| `device revoke [--device D] --yes` | Remove this device's spending permission (other devices keep theirs; the shared token approval stays). --device D removes another device of this wallet, e.g. a computer that is gone. | yes |

### VPN service (dvpnd)

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `daemon version` | Service build and network. |  |
| `daemon doctor` | Service health checks (ok / warn / fail). |  |
| `daemon dns-check [--dns handshake\|cloudflare\|ip,ip]` | Ask each DNS server one question from this computer; exit 1 when none answers (same check as the Settings DNS picker). |  |
| `daemon drivers` | WireGuard, AmneziaWG, OpenVPN 2.6 + adapter: ready or missing (no admin). |  |
| `daemon repair-drivers --yes` | Install or repair missing VPN drivers (Windows: one admin prompt; Android: re-links the bundled protocol programs). | yes |
| `daemon init` | Create the device key (no admin needed). |  |
| `daemon install --yes` | Install and start the service (Windows: one admin prompt; Android: the engine runs inside the app, nothing to install). | yes |
| `daemon settings` | Kill switch, DNS, LAN, RPC (key hidden). |  |
| `daemon set [--kill-switch off\|on\|persist] [--dns handshake\|cloudflare\|ip,ip] [--dns-mode netsh\|vpn\|none] [--allow-lan true\|false] [--whole-device true\|false] [--split-mode off\|include\|exclude] [--split-apps "C:pathapp.exe;..."\|none] [--split-routes IP-or-CIDR,...\|none] [--basis per_gb\|per_hour] [--escrow tDVPN] [--prepay-mb N] [--prepay-minutes N] [--rpc URL] [--rpc-ws URL] --yes` | Change service settings and restart it (Windows: admin prompt; Android: vpn is the DNS mode, and --whole-device / --split-* are desktop only: use split set / split routes). | yes |
| `daemon restore-network` | End any session, release kill switch and proxy. |  |

### Servers

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `nodes list [--online] [--country DE] [--protocol wireguard] [--sort price] [--no-probe]` | Every listed server, checked live. |  |
| `nodes show <node>` | One server: prices, protocols, signature checks. |  |
| `nodes fav <node>` | Add or remove a favourite. |  |
| `nodes recent` | Servers you used most recently. |  |
| `cost <node> [--basis per_gb\|per_hour] [--units N]` | Exact deposit before you connect. |  |

### Connect + sessions

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `connect <node> [--basis per_gb\|per_hour] [--units N] [--plan <subscription>] [--switch] --yes` | Pay a deposit (or use a plan) and connect. | yes |
| `connect <node> … --follow` | Connect, then print usage every 5 s. *(CLI only: The Connect screen shows live usage.)* | yes |
| `disconnect` | Stop the session; the deposit settles later. |  |
| `sessions` | Sessions the service holds. |  |
| `tickets` | Plan access tickets the service holds. |  |
| `proxy status` | SOCKS endpoint and system-proxy state. |  |
| `proxy on --yes` | Point Windows apps at the session SOCKS proxy. | yes |
| `proxy browser [--browser edge\|chrome] [--url U]` | Open Edge or Chrome in its own profile through the session (only that window uses the VPN). |  |
| `proxy off` | Restore your own proxy settings. |  |
| `split status` | Desktop: split tunnelling mode, chosen apps and addresses, and what each protocol does with them. |  |
| `split show` | Android: which apps use the VPN (all, only these, all except these). |  |
| `split apps [--search TEXT]` | Apps you can choose: Android, apps with a launcher icon and their package names; desktop, installed and running apps (full paths for daemon set --split-apps). |  |
| `split set all\|include\|exclude [package…]` | Android: choose apps for the VPN, every protocol. Applies from the next connect. |  |
| `split routes all\|include\|exclude [address\|network…]` | Android: choose addresses for the VPN (like 10.0.0.0/8), every protocol. Applies from the next connect. |  |

### Plans + subscriptions

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `plans list` | Every plan on the network. |  |
| `plans roster <plan>` | Servers on a plan, live or down. |  |
| `plans subscribe <plan> --yes` | Buy a plan (no refund). | yes |
| `plans subscriptions` | Your subscriptions and time left. |  |
| `plans close <subscription> --yes` | End a subscription (rent back, no refund). | yes |

### Deposits, refunds, history

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `channels` | Deposits the service holds. |  |
| `channels fund <channel> --tdvpn N --yes` | Top up a deposit that is still open. | yes |
| `settle list [--device D]` | Deposits waiting to be refunded. --device D lists the deposits of a removed device. |  |
| `settle run [--channel C] [--device D] --yes` | Start / finish closing deposits. --device D settles the deposits of a removed device. | yes |
| `settle withdraw --yes` | Move refunds back to the wallet. | yes |
| `history list` | Every session with data and spend. |  |
| `history summary` | Totals, last 30 days, top servers. |  |
| `history export [--out file.csv]` | Session history as CSV. |  |

### Node testing

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `test plan <node…> \| --online` | Most a test run could lock in deposits (no transaction). |  |
| `test run <node…> \| --online [--max-nodes N] [--max-spend N] --yes` | Real session on each server, one at a time: connect time, exit IP, DNS, speed → FAST / SLOW / FAIL. Test deposits are closed after. | yes |
| `test stop` | Stop a running test at its next step (the server being tested is disconnected first; it shows as CANCELLED). Ctrl-C does the same in the terminal running it. |  |
| `test history` | Past test runs with FAST / SLOW / FAIL counts. |  |
| `test show [run-id] [--compare]` | One run per server (latest if no id); --compare shows what changed since the run before. |  |
| `test export [run-id] [--out file.json]` | A run as JSON. |  |

### Diagnostics

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `quality ip` | Public IP as websites see it. |  |
| `quality speed` | Download speed test. |  |

### Settings + RPC

| Command | What it does | Asks for `--yes` |
|---|---|---|
| `rpc state` | Endpoint in use, slot, latency (key hidden). |  |
| `rpc set <url> [url…]` | Your own Solana RPC endpoints (https). |  |
| `poll show` | Background refresh cadences: current, default and allowed range for each job. |  |
| `poll set <job>=<seconds> …` | Change how often a background job runs (wallet, nodes, plans, subscriptions, settlements, ip, dns, rpc, session). |  |
| `poll reset [job…]` | Put cadences back to their defaults. |  |
| `poll run [job…]` | Run background jobs once now and show how long each took. |  |
| `poll watch [--seconds N] [--hidden]` | Run the real scheduler for N seconds and check every job kept its cadence (exit 1 if not). |  |
| `settings get` | App settings. |  |
| `settings set key=value …` | Change app settings (unknown keys refused). |  |
| `settings reset --yes` | Restore default app settings; favourites and RPC endpoints are kept. | yes |
<!-- cli-catalogue:end -->

## Tests
- `tests/unit/cli-map.test.ts`: every app function → a CLI command; every command documented here.
- `scripts/e2e/cli-e2e.sh [local|daemon|all] [--spend]`: runs the commands against devnet
  (spend tier needs a rig: `scripts/e2e/wsl-rig.sh` or `scripts/e2e/box-rig.sh`).
