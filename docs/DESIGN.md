# Design standard — Devnet dVPN

The look: a near-black canvas with corner glows and card surfaces, a structured layout with
a display face for headings, and gold reserved for warnings. Brand colour is the **Solana**
purple → green gradient. Tokens live in `src/renderer/src/styles/index.css`; every colour is a
token, so dark and light come from one stylesheet.

## Tokens

| token | dark | light | use |
|---|---|---|---|
| `--bg` | `#0a0b0d` | `#f6f7f9` | canvas, with purple top-left and green bottom-right glows |
| `--bg-card` / `--bg-raised` / `--bg-hover` | `#121417` / `#181b1f` / `#1e2227` | white / `#fafafc` / `#eef0f4` | cards, raised rows, hover |
| `--sol-purple` → `--sol-green` | `#9945FF` → `#14F195` | same | primary buttons, connection ring, logo, progress — brand only |
| `--accent` / `--accent-ink` | `#9945FF` / `#c096ff` | `#7c3aed` / `#6d28d9` | focus, links, active nav (light uses a darker violet for contrast) |
| `--green` | `#14F195` | `#06965c` | Protected, online, latency |
| `--yellow` | `#ffc701` | `#b07800` | warnings and the DEVNET · TEST TOKENS badge only |
| `--red` | `#ff5a5f` | `#d63038` | errors, destructive confirm |

Rules: no hard-coded colours in components; gradient only for brand and primary action; at most
one primary button per view; gold never for success.

## Type

| family | weight | use |
|---|---|---|
| Outfit (variable) | 400–700 | body, labels |
| Tomorrow | 600–800 | headings, big numbers, the connection title |
| JetBrains Mono (variable) | 400–500 | addresses, signatures, the CLI terminal |

All fonts and flags are **bundled** (`@fontsource*`, `flag-icons`): CSP is `font-src 'self'`, and a
CDN fetch would tell a third party the app is open.

## Layout

- Left sidebar (brand, 8 screens, status pill, DEVNET badge), main panel right, app-wide banners
  on top of the main panel (RPC warning, low funds, Restore network).
- Onboarding and welcome: split screen, brand story left, steps right (one-shot standard).
- Home: connection card (ring + state + one primary action), then stat cards, then chips
  (IP · protocol · DNS · country) while connected.
- Servers: search + protocol + pricing + sort on one row; countries collapsed with flag and
  `online/total`; each row shows both prices, protocol, latency and Connect.

## Copy

- Plain words: "server" not "node" in the app UI; "deposit", "refund", "spending permission".
- Never raw errors on screen; the raw text goes to the log (`link-copy.ts`, `state.ts`).
- Country names from the standard map (`core/nodes/country.ts`): short display names
  (United States, United Kingdom, Hong Kong, DR Congo, Turkey), flags as images.
- Usage and spend say "Approximate · every minute".

## CLI section (standard, from #28b Node Manager)

Every app has a **CLI screen** and a matching command-line tool built from one catalogue
(`src/cli/catalogue.ts`), so the in-app list, `devnet-dvpn help` and `docs/CLI.md` can never
drift (`npm run docs:cli`; a unit test fails if they do).

- Left: commands grouped (Wallet, Device, Daemon, Servers, Connect, Plans, Deposits…), filter
  box, count; each entry can insert, copy or run.
- Right: terminal with history (↑/↓), output kept when switching screens, Clear.
- Commands that spend or change settings need `--yes`, shown in the usage; without it they print
  what would happen and exit 2.
- "Open in PowerShell" defines a `devnet-dvpn` function for that window that runs the app binary
  as Node — nothing is installed or added to PATH.
- Exit codes: 0 ok, 1 failed, 2 needs `--yes`, 3 usage error.

## Checking it

`DVPN_UI_SMOKE=<dir> DVPN_UI_SMOKE_THEME=dark|light electron .` walks all screens and saves
screenshots plus `errors.json` (must be `[]`). Review both themes after any UI change.

## Android (the Android app)

- Bottom bar (Connect, Servers, Plans, Wallet, More) under `md`; the desktop sidebar stays for
  wide screens. Rows are at least 48 dp tall; grids collapse to one column at phone width
  (`ui.mjs overflow` checks for horizontal scroll at 360–420 dp).
- **One primary per view; Apply bars are sticky** at the bottom of Split tunnelling and Kill
  switch and say what applying does ("Apply and reconnect" / "Apply and disconnect").
- **Protocol marks** wherever a protocol is named, the notification included (bundled PNGs in
  `res/drawable-nodpi`; WireGuard: name only, per its trademark policy).
- **Honest live state:** lanes and exits come from the saved choice and measured IPs, never the
  draft; "Blocking internet" comes from the VPN service's own held flag.
- App icons in the split list are drawn by the Kotlin shell (base64 PNG, checked), never fetched.
- Research behind the two pages: `docs/UI-STANDARDS-RESEARCH.md`. Every control → CLI:
  `docs/UI-CONTROLS.md`.
