# Windows installer — Devnet dVPN

One file for the user: `Devnet-dVPN-Setup-<version>-x64.exe`. They run it, accept one
administrator prompt, and every protocol is ready. Nothing is downloaded at install time.

## What the user gets

| Step | What happens | Where |
|---|---|---|
| Welcome + license | our MIT license, then every bundled component's license and source link | `build/license.txt` (generated) |
| Install folder | default `C:\Program Files\Devnet dVPN`, changeable; per-machine | NSIS `perMachine` |
| Files | app, `dvpnd.exe`, `pipe-bridge.exe`, V2Ray / Xray / Hysteria2 binaries, driver MSIs, PowerShell helpers | `resources\resources\` |
| VPN drivers | WireGuard 1.1.1, AmneziaWG 3.1.0, OpenVPN 2.6.23 + "OpenVPN Wintun" adapter, installed silently if missing | `install-deps.ps1` |
| CLI | `devnet-dvpn` on the machine PATH (new terminals) | `bin\devnet-dvpn.cmd` |
| Shortcuts | Start menu + desktop, "Run Devnet dVPN" on the last page | NSIS |
| Notices | `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` in the install folder | `extraFiles` |

Not done at install, by design: wallet, device key, and the `dvpnd` Windows service. The
service needs the owner's address and a funded, permitted device, so the app's first-run
setup installs it (one more admin prompt, `setup-daemon.ps1`).

## Dependencies are pinned and verified twice

`build/deps.lock.json` pins every third-party program by version, URL and SHA-256.

1. **Build time** — `scripts/fetch-deps.mjs` downloads into `build/.deps-cache/` (or reuses
   it), refuses any hash mismatch, copies MSIs to `resources/deps/` and extracts only the
   listed files from the zips. It writes `resources/deps/deps.json` (name, version, file,
   SHA-256, Authenticode signer), `build/THIRD-PARTY-NOTICES.txt` and `build/license.txt`.
2. **Install time** — `install-deps.ps1` re-hashes each MSI and checks that its Authenticode
   signature is **Valid** and that the signer is the expected publisher (WireGuard LLC,
   Privacy Technologies OU, OpenVPN Inc.) before `msiexec` runs it.

Bumping a dependency: change `url` + `version` + `sha256` in the lock file, rerun
`npm run deps:fetch`, then prove that protocol live (BOX-RIG → Laptop client).

## install-deps.ps1 rules

- Already installed → left alone. Older WireGuard / AmneziaWG → upgraded, **but never while
  one of its tunnels is running** (that would drop the connection).
- OpenVPN **2.7+ is never downgraded**: it is reported `incompatible` (2.7 removed Wintun,
  UPSTREAM-GAPS #21) and Diagnostics tells the user to uninstall it, then Repair.
- WireGuard / AmneziaWG install with `DO_NOT_LAUNCH=1`; their GUI manager service is
  stopped (dvpnd drives tunnels itself).
- MSI exit 3010 / 1641 = success, `rebootRequired` set.
- `-CheckOnly` reports without installing (no admin). The app's Diagnostics and
  `devnet-dvpn daemon drivers` use it; **Repair drivers** / `daemon repair-drivers --yes`
  run it elevated.
- Report: `%ProgramData%\Devnet dVPN\install-deps.json` (+ `.log`, `msi-<name>.log`).
- Exit 0 = ready, 2 = something missing. The installer then shows one warning (skipped in
  silent mode) and finishes: the protocols that are ready still work.
- PowerShell scripts that 5.1 runs stay **ASCII-only**: 5.1 reads BOM-less UTF-8 as
  cp1252, and a `→` turns into a stray quote that breaks the script.

## Install / upgrade / uninstall hooks (`build/installer.nsh`)

| Hook | Does |
|---|---|
| `customInit` | if the `dvpnd` service runs, stop it cleanly (ends the session, releases kill switch + DNS) so its files can be replaced |
| `customInstall` | `install-deps.ps1`; `path-entry.ps1` adds `$INSTDIR\bin`; restart the service if it was running |
| `customUnInit` | stop the service + `pipe-bridge`; copy the cleanup scripts + `dvpnd.exe` to `$PLUGINSDIR` |
| `customUnInstall` | full uninstall only (not an upgrade): `uninstall-cleanup.ps1` (restore the user's proxy, remove the service, remove leftover `WireGuardTunnel$dvpn-*` / `AmneziaWGTunnel$dvpn-*`), take the CLI off PATH |

electron-builder deletes `$INSTDIR` **before** `customUnInstall`, which is why the scripts
are copied out in `customUnInit`. The installer is a 32-bit process: hooks call the 64-bit
PowerShell through `%WINDIR%\sysnative`, and scripts use `ProgramW6432`.

Kept on uninstall on purpose: the shared drivers (other apps may use them) and
`C:\ProgramData\dvpnd\client` (the device key holds an on-chain permission and SOL; a
reinstall picks it up again).

## Packaging rule: main and CLI are self-contained bundles

electron-builder 25 re-nests deduplicated npm packages: it shipped `@solana/options`
without the `@solana/codecs-core` it requires, and both the app and the CLI crashed on
start. The main process (`electron.vite.config.ts`) and the CLI (`scripts/build-cli.mjs`)
therefore bundle every runtime dependency; only `electron` and ws's optional native addons
stay external. Anchor is aliased to its CJS build (its ESM build keeps bare `require()`s).

## CLI shim

`bin\devnet-dvpn.cmd` runs the bundled CLI on the app's own runtime
(`ELECTRON_RUN_AS_NODE=1 "Devnet dVPN.exe" resources\app.asar\out\cli\devnet-dvpn.cjs`),
the same pattern as VS Code's `code.cmd`. CRLF line endings (`.gitattributes`).

## Build

```bash
npm run release:win          # fetch-deps → typecheck → unit tests → build → CLI → electron-builder → SHA256SUMS
node scripts/release-win.mjs --offline   # cache only (no downloads)
npm run icon                 # build/icon.svg → build/icon.ico + icon.png (Electron renders it)
```

Output: `dist/Devnet-dVPN-Setup-<version>-x64.exe`, `.blockmap`, `SHA256SUMS.txt`.
`dvpnd.exe` and `pipe-bridge.exe` must be in `resources/bin/` first (local builds, never
committed; the lock file's `local` list is checked).

## Signing

Unsigned builds work but SmartScreen shows **"Unknown publisher"** and may need
"More info → Run anyway". To sign: put an OV/EV code-signing certificate in `CSC_LINK`
(path or base64 `.pfx`) and its password in `CSC_KEY_PASSWORD`; electron-builder then signs
the app, every bundled `.exe`, the uninstaller and the setup file. **Owner decision
pending:** no certificate exists yet.

## Silent install (IT / test rigs)

```bat
Devnet-dVPN-Setup-0.1.0-x64.exe /S              :: all users, default folder
Devnet-dVPN-Setup-0.1.0-x64.exe /S /D=D:\Apps\Devnet dVPN
"C:\Program Files\Devnet dVPN\Uninstall Devnet dVPN.exe" /S
```

## Proof — clean Windows VM (2026-10-20)

Fresh GCP Windows Server 2022 VM, nothing preinstalled, real setup `.exe` from
`npm run release:win`, driven by `scripts/e2e/vm-installer-test.ps1` (VM deleted afterwards).

| phase | result |
|---|---|
| silent install | exit 0 in 70 s; **25/25 checks**: app + `dvpnd`/`pipe-bridge`/v2ray/xray/hysteria2 present, WireGuard 1.1.1 + AmneziaWG 3.1.0 + OpenVPN 2.6.23 installed and their managers not running, "OpenVPN Wintun" adapter, `install-deps.json` ok, CLI on PATH in a new shell, `daemon drivers` ready, Apps & features + Start menu entries |
| first run | new wallet (key file: DPAPI has no key for an SSH logon) → `daemon init` → `device setup` → `daemon install` (Administrator: elevated step ran with no prompt) → WireGuard connect: exit IP = node, 51 Mbps → disconnect: direct IP back → `settle run` → `device revoke` → funds returned |
| upgrade over the top | exit 0 in 57 s; service stopped before files were replaced and Running after; one PATH entry; drivers untouched |
| uninstall | **9/9**: exit 0, service removed, no `dvpn-*` tunnel services, CLI off PATH, system proxy off, internet works, shared drivers and device key folder kept |

Bugs this run found and fixed: packaged app crashed on a dropped nested npm package (bundles
are now self-contained); the old uninstall hook ran a script already deleted (copied to
`$PLUGINSDIR` first); a false "Something went wrong" after a successful connect; a false
"DNS could not be restored" (UPSTREAM-GAPS #25); RPC hanging through WireGuard on a 1460-MTU
node host (UPSTREAM-GAPS #26).
