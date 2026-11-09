# Sentinel dVPN for Android (Solana devnet)

Devnet dVPN is a pure peer-to-peer dVPN app on the Sentinel Solana devnet protocol. Pick any server and pay it directly, or subscribe to any plan. No accounts, no servers in the middle. Kotlin shell + WebView UI + embedded Node and the `dvpnd` daemon. Built on [Sentinel](https://sentinel.co).

## Download

Latest release: <https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-android/releases/latest>

| Platform | File |
|---|---|
| Android 10+ (arm64-v8a and x86_64) | `app-f61-0.1.4-release.apk` |
| Checksums | `SHA256SUMS` |

All files: <https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-android/releases/latest>

## Status: devnet, release candidate, unsigned

- Runs on the **Sentinel Solana devnet** only. Devnet tokens have no value; do not use a wallet that holds real funds.
- This is **release candidate 2 (RC2)**, built on the Sentinel Solana fork cut `final6.1` (`02b22fc`, based on [sentinel-official/sentinel-solana](https://github.com/sentinel-official/sentinel-solana) `26de5240`).
- Builds are **not code-signed by a publisher** (see the platform note below), so the OS will warn on first run. Verify the download against `SHA256SUMS` first.

## Verify a download

Download `SHA256SUMS` and the file(s) from the [release](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-android/releases/latest) into one folder, then:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

## Test results and known issues

Test results, the bug catalogue and open issues for every Sentinel dVPN client live in the testing-tools repository:

- Results and tools: <https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools>
- Known issues for RC1/RC2: <https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools/blob/main/docs/known-issues-rc1.md>

## License

[Sentinel dVPN License](LICENSE). Third-party components keep their own licenses (see `THIRD-PARTY-NOTICES`).

Android note: the APK is a release build signed with the Android debug key, not a store key. Enable "install unknown apps" for your browser or file manager to sideload it.

## Install

Download the APK, verify it, open it on the device and accept the install prompt. On first run grant the VPN permission; the app sets up a device wallet and connects through the VPN service.

## Build from source

The Android build needs the Android SDK/NDK, Go and Node; the daemon is built separately with `scripts/build-dvpnd-android.sh` from the Sentinel Solana fork cut.

```bash
npm ci
npm test
bash scripts/fetch-android-deps.sh
bash scripts/build-dvpnd-android.sh
cd android && ./gradlew assembleRelease
```

Corresponding source for the GPL components (OpenVPN, OpenSSL) is linked from `src/renderer/public/THIRD-PARTY-NOTICES.txt` and built by `scripts/build-openvpn-android.sh`.

Docs: [architecture](docs/ARCHITECTURE.md), [CLI](docs/CLI.md), [design](docs/DESIGN.md), [network safety](docs/NETWORK-SAFETY.md), [parity](docs/ANDROID-PARITY.md).
