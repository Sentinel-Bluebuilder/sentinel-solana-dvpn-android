# Settings map — everything configurable, where it lives, how it is set and tested

Owner rule (2026-10-21): anything configurable is a CLI function and has automated tests.
`tests/unit/settings-coverage.test.ts` fails when a new option has no CLI path or no Settings
screen control. `scripts/e2e/settings-e2e.sh` sets, reads back and refuses every app option
through the CLI (110 checks, laptop-safe). Service options are proven on the VM
(`scripts/e2e/vm-cli-sweep.ps1` section D) because they need an admin prompt and a restart.

## 1. App settings — `<data>/settings.json` (instant, per user)
Allow-listed and clamped by `src/main/system/settings.ts` `sanitize()`; unknown keys dropped.
CLI writes report a dropped value as `Invalid value … (left unchanged)`, exit 1.

| Key | Values | Default | Screen | CLI |
|---|---|---|---|---|
| `defaultBasis` | `per_gb` \| `per_hour` | `per_gb` | Settings → Connection defaults | `settings set defaultBasis=per_hour` |
| `defaultGb` | GB_OPTIONS (1–50) | 1 | same | `settings set defaultGb=5` |
| `defaultHours` | HOUR_OPTIONS (1–24) | 1 | same | `settings set defaultHours=2` |
| `preferredCountry` | ISO 3166 alpha-2 (`US`) or `null` | null | same | `settings set preferredCountry=US` |
| `allowanceTdvpn` | positive tDVPN, ≤ 6 decimals | 50 | same (Device spending limit) | `settings set allowanceTdvpn=25` |
| `autoConnect` | bool | false | Settings → App | `settings set autoConnect=true` |
| `autoTopUpDevice` | bool | true | same (Top up this device's SOL automatically) | `settings set autoTopUpDevice=false` |
| `startWithOs` | bool | false | same | `settings set startWithOs=true` |
| `closeToTray` | bool | true | same | `settings set closeToTray=false` |
| `notifications` | bool | true | same | `settings set notifications=false` |
| `thirdPartyChecks` | bool (IP check + speed test) | true | same | `settings set thirdPartyChecks=false` |
| `theme` | `system` \| `dark` \| `light` | system | same | `settings set theme=dark` |
| `language` | `en` (v1 English only) | en | — | `settings set language=en` |
| `rpcUrls` | 1–8 https URLs (http only for 127.0.0.1) | public devnet | Settings → Solana RPC | `rpc set <url…>`, `rpc state` |
| `favourites` | node addresses (≤ 500) | [] | star on a node | `nodes fav <node>` (toggle) |
| `poll` | seconds per job, see §3 | §3 | Settings → Background refresh | `poll show / set / reset` |

## 2. Service settings — `C:\ProgramData\dvpnd\client\config.toml` (+ root config)
Validated by `src/core/daemon/config.ts` `validateSettings()` before anything is asked;
applied by one administrator prompt + service restart (`applyDaemonSettings`).
Read: `daemon settings` (escrow in tDVPN, prepay in MB / min).

| Field | Values | Screen | CLI flag |
|---|---|---|---|
| `killSwitch` | off \| on \| persist (Windows: on/persist refused for WG/AWG/OpenVPN, gap #29) | Settings → VPN service | `--kill-switch` |
| `dnsServers` | preset handshake / cloudflare / google / quad9, or 1–4 IPs | same | `--dns` |
| `allowLan` | bool | same | `--allow-lan` |
| `basis` | per_gb \| per_hour (sessions started outside the app) | same (Service defaults) | `--basis` |
| `escrow` | positive tDVPN (stored as base units) | same | `--escrow` |
| `prepayBytes` | whole MB | same | `--prepay-mb` |
| `prepaySeconds` | whole minutes | same | `--prepay-minutes` |
| `rpcUrl` | https URL | same | `--rpc` (also sets the websocket URL) |
| `rpcWsUrl` | wss URL | derived from Service RPC | `--rpc-ws` |
| `dnsMode` | read-only (daemon's DNS backend) | — | `daemon settings` |

## 3. Background refresh — `poll` (src/shared/poll.ts)
The scheduler (`src/main/scheduler.ts`) reads these live; a change applies on the next tick.
`poll watch --seconds N [--hidden]` runs the real scheduler and fails (exit 1) if any job runs
more often than its interval, never runs when due, or runs while hidden when it should pause.

| Job | Default s | Range s | Runs while hidden |
|---|---|---|---|
| wallet | 60 | 15–3600 | no |
| nodes | 300 | 60–3600 | no (skips while the list on disk is fresh) |
| plans | 600 | 60–7200 | no |
| subscriptions | 600 | 60–7200 | no |
| settlements | 60 | 15–3600 | **yes** (refunds must not wait) |
| ip | 30 (while connected; once when idle) | 10–600 | no |
| dns | 15 | 5–600 | no |
| rpc | 60 | 15–3600 | no |
| session | 5 (only when the live stream drops) | 2–60 | yes (services/connection.ts) |

## 4. Fixed on purpose (not settings)
RPC query timeout 12 s, rate-limit cooldown 8 s, endpoint bench 60 s (`core/chain/rpc.ts`);
tx confirm 60 s (`core/chain/tx.ts`); daemon call deadline 20 s, StartSession 120 s
(`core/daemon/client.ts`); ticket retry 1.5 / 3 / 6 s (`core/session/state.ts`). These are
safety limits, tested by unit tests and the fault-injection rows of the edge matrix; exposing
them would let a user make the app hang or hammer a public RPC.
