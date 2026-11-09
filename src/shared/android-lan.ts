// ─── What "Allow local network" leaves outside the VPN on Android ───
// Must equal vpn/RouteSplit.kt LAN (tests/unit/android-lan.test.ts reads the Kotlin file).
export const ANDROID_LAN_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fe80::/10', 'fc00::/7'] as const;
