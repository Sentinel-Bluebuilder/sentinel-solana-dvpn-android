// ─── Where the cb33 daemon lives on each OS: names, paths, service, CLI arguments ───
// Shared by every desktop app (the Windows app Windows, the Linux app Linux, the macOS app Mac; the Android app Android overrides the paths).
// Upstream cb33092e (and the fork pinned on it) replaced the old layout:
//   old: binary `dvpnd`, home <root>/dvpnd/client with config.toml + client/config.toml,
//        `dvpnd init --role client`, key "device", socket_group in [daemon], our own service unit.
//   new: binary `sentinel-dvpnd`, one instance per tag (client = c0) in <state root>/<tag> with ONE
//        config.toml (client keys at the top level, [network], [split], [key], then [daemon] [log]
//        [rpc] [tx]), per-service files <dir>/<service>/config.toml, key "operator" in <dir>/keys,
//        and the service written by `sentinel-dvpnd service install` (socket group sentinel-dvpn).
// Facts from sentinel-go-sdk/daemon/instance/instance.go and sentinel-dvpnd/cmd/sentinel-dvpnd
// (init.go, service.go, systemd.go) on fork-cb33-1-rc (b036236). Pure functions: no fs, no process.
//
// The ONE table every app uses (client instance c0: dvpnd has no default, `--instance` is required,
// and c0 is the first client tag; folders are named after ProductName "sentinel-dvpn", only the
// binary and the service carry the "d"):
//   OS       home (instance dir)                                socket / pipe                                             service
//   linux    /var/lib/sentinel-dvpn/c0                          /var/lib/sentinel-dvpn/c0/daemon.sock                     sentinel-dvpnd@c0 (+ sentinel-dvpnd@c0.socket)
//   darwin   /Library/Application Support/sentinel-dvpn/c0      <home>/daemon.sock                                        co.sentinel.sentinel-dvpnd.c0
//   win32    %ProgramData%\sentinel-dvpn\c0                     \\.\pipe\ProtectedPrefix\Administrators\sentinel-dvpn\c0  sentinel-dvpnd$c0
//   android  <filesDir>/sentinel-dvpn/c0                        <home>/daemon.sock                                        none (the app's VPN service runs it)
// Android (GOOS "android"): the app always passes --home, since dvpnd's StateRoot is a root path an
// app cannot write. dvpnd makes the home 0750 (prepareInstanceDir; no group change outside the state
// root) with 0700 folders and 0600 files inside, in the app's private filesDir.
// The app runs `sentinel-dvpnd run --instance c0 --home <home>` itself (DaemonProcess.kt has the
// same names and args; keep both in step).
// The macOS home has a SPACE: pass every path as its own argv entry (execFile, never a shell
// string), and quote it in any script or unit text.

export type Goos = 'linux' | 'darwin' | 'win32';

// ─── Protocol bits (node accounts' `protocols` mask) ───
// cb33 CHANGED the table (sentinel-go-sdk <proto>/<proto>.go protocolBit on fork-cb33-1-rc):
//   wireguard 1<<0, v2ray 1<<1, openvpn 1<<2, amneziawg 1<<3, xray 1<<4, hysteria2 1<<5.
// Before cb33 it was xray 4, openvpn 8, hysteria2 16, amneziawg 32: reading a cb33 node with that table
// mislabels 4 of the 6 protocols (and the app dials the wrong service).
export const PROTOCOL_BITS: Array<[number, string]> = [
  [1, 'wireguard'],
  [2, 'v2ray'],
  [4, 'openvpn'],
  [8, 'amneziawg'],
  [16, 'xray'],
  [32, 'hysteria2'],
];

export const DAEMON_NAME = 'sentinel-dvpnd';
export const PRODUCT_NAME = 'sentinel-dvpn';
/** The group the service gives its control socket to (cb33 instance.GroupName). */
export const DAEMON_GROUP = PRODUCT_NAME;
/** The app's one client instance. */
export const CLIENT_INSTANCE = 'c0';
/** The key the client signs with (cb33 config.operatorKeyName). */
export const OPERATOR_KEY = 'operator';
/** The same key's name in a home made before cb33. */
export const LEGACY_DEVICE_KEY = 'device';
export const CONFIG_FILE = 'config.toml';
export const KEYS_DIR = 'keys';
export const SOCKET_FILE = 'daemon.sock';

const TAG = /^[cnp](0|[1-9][0-9]{0,8})$/;
function checkTag(tag: string): string {
  if (!TAG.test(tag)) throw new Error(`not an instance tag: ${tag}`); // copy:internal
  return tag;
}

export function daemonBinaryName(goos: Goos): string {
  return goos === 'win32' ? `${DAEMON_NAME}.exe` : DAEMON_NAME;
}

/** instance.StateRoot. Windows: %ProgramData%\sentinel-dvpn. */
export function stateRoot(goos: Goos, programData = 'C:\\ProgramData'): string {
  if (goos === 'darwin') return `/Library/Application Support/${PRODUCT_NAME}`;
  if (goos === 'win32') return `${programData.replace(/\\+$/, '')}\\${PRODUCT_NAME}`;
  return `/var/lib/${PRODUCT_NAME}`;
}

/** Tag.StateDir: the instance folder (config, keys, data.db, and the socket off Windows). */
export function instanceDir(goos: Goos, tag = CLIENT_INSTANCE, programData?: string): string {
  return `${stateRoot(goos, programData)}${goos === 'win32' ? '\\' : '/'}${checkTag(tag)}`;
}

/** Tag.Endpoint / Loaded.endpoint: a named pipe on Windows, <instance dir>/daemon.sock elsewhere. */
export function daemonEndpoint(goos: Goos, tag = CLIENT_INSTANCE, programData?: string): string {
  if (goos === 'win32') return `\\\\.\\pipe\\ProtectedPrefix\\Administrators\\${PRODUCT_NAME}\\${checkTag(tag)}`;
  return `${instanceDir(goos, tag)}/${SOCKET_FILE}`;
}

/** Tag.ServiceName: systemd template instance, launchd label, or Windows service name. */
export function serviceName(goos: Goos, tag = CLIENT_INSTANCE): string {
  checkTag(tag);
  if (goos === 'darwin') return `co.sentinel.${DAEMON_NAME}.${tag}`;
  if (goos === 'win32') return `${DAEMON_NAME}$${tag}`;
  return `${DAEMON_NAME}@${tag}`;
}

/** Tag.Interface: the tunnel interface name for this instance. */
export const tunnelInterface = (tag = CLIENT_INSTANCE): string => `dvpn-${checkTag(tag)}`;
/** Tag.ObjectName: the kill-switch table / WFP / pf anchor name for this instance. */
export const firewallObject = (tag = CLIENT_INSTANCE): string => `${PRODUCT_NAME}-${checkTag(tag)}`;
/** Tag.EnvPath (Linux): the EnvironmentFile the systemd unit reads. */
export const serviceEnvFile = (tag = CLIENT_INSTANCE): string => `/etc/${PRODUCT_NAME}/${checkTag(tag)}.env`;

// ─── Android row ───
const trimSlash = (dir: string): string => dir.replace(/\/+$/, '');
/** The c0 home inside the app's files dir (Context.filesDir). */
export const androidInstanceDir = (filesDir: string, tag = CLIENT_INSTANCE): string => `${trimSlash(filesDir)}/${PRODUCT_NAME}/${checkTag(tag)}`;
export const androidEndpoint = (filesDir: string, tag = CLIENT_INSTANCE): string => `${androidInstanceDir(filesDir, tag)}/${SOCKET_FILE}`;
/** The pre-cb33 Android home (config.toml + client/config.toml, key "device"). */
export const androidLegacyHome = (filesDir: string): string => `${trimSlash(filesDir)}/dvpnd/client`;

/** The pre-cb33 client home each app used (migrated once into the c0 instance). */
export function legacyHome(goos: Goos): string {
  if (goos === 'darwin') return '/var/db/dvpnd/client';
  if (goos === 'win32') return 'C:\\ProgramData\\dvpnd\\client';
  return '/var/lib/dvpnd/client';
}

// ─── CLI arguments ───
// `--home` overrides the instance folder (a staging copy the user can write); `--instance c0` tells
// dvpnd the role (c = client), so there is no --role any more.
const at = (home?: string): string[] => ['--instance', CLIENT_INSTANCE, ...(home ? ['--home', home] : [])];

/** Make a client instance in `home` (reuses a key already in <home>/keys; --new-key would replace it). */
export const initArgs = (home: string, owner: string): string[] => ['init', ...at(home), '--owner', owner, '--plain-key'];
export const keyListArgs = (home?: string): string[] => ['key', 'list', ...at(home)];
/** The long-running daemon (on Android the app's VPN service runs this itself). */
export const runArgs = (home: string): string[] => ['run', ...at(home)];
export const doctorArgs = (home?: string): string[] => ['doctor', ...at(home)];
/** `service install|start|stop|restart|status|uninstall`: root or administrator only. */
export const serviceArgs = (action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall'): string[] => ['service', action, ...at()];

/** The signing key in `key list` output: "operator", or "device" in a home made before cb33. */
export function operatorKey<K extends { name: string }>(keys: K[]): K | undefined {
  return keys.find((k) => k.name === OPERATOR_KEY) ?? keys.find((k) => k.name === LEGACY_DEVICE_KEY);
}
