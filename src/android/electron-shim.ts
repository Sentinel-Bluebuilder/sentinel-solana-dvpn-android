// ─── `electron` for the Android main bundle ───
// The Android app runs the Windows app's main-process code in plain Node (D-A3). esbuild aliases `electron`
// to this module (scripts/build-android-main.mjs), so ipc.ts and the services load unchanged.
// What Electron did through its own APIs goes to the Kotlin shell via the app bridge.
import { bridgeCall } from '../main/platform/android-bridge';
import { log } from '../main/logger';

type InvokeHandler = (event: unknown, payload: unknown) => unknown;

/** Every ipcMain.handle(...) lands here; android/main.ts dispatches renderer calls to it. */
export const handlers = new Map<string, InvokeHandler>();

function fireAndForget(req: Record<string, unknown>, what: string): void {
  bridgeCall(req).then((r) => { if (!r.ok) log.warn(`${what} failed`, { error: r.error }); }).catch((err) => log.warn(`${what} failed`, err));
}

export const ipcMain = {
  handle(channel: string, fn: InvokeHandler): void { handlers.set(channel, fn); },
  removeHandler(channel: string): void { handlers.delete(channel); },
  on(): void { /* renderer → main sends are not used by this app */ },
};

const version = process.env.DVPN_APP_VERSION ?? '0.0.0';

export const app = {
  getVersion: (): string => version,
  getName: (): string => 'Devnet dVPN',
  getAppPath: (): string => process.env.DVPN_NODE_ROOT ?? process.cwd(),
  getPath: (_name: string): string => process.env.DVPN_DATA_DIR ?? process.cwd(),
  isPackaged: true,
  setName(): void {},
  setPath(): void {},
  setLoginItemSettings(): void {},
  quit(): void { process.exit(0); },
  exit(code = 0): void { process.exit(code); },
  on(): void {},
  whenReady: (): Promise<void> => Promise.resolve(),
};

export const shell = {
  openExternal(url: string): Promise<void> {
    return bridgeCall({ op: 'openUrl', url }).then((r) => { if (!r.ok) throw new Error(r.error ?? 'Could not open the link.'); });
  },
  openPath(p: string): Promise<string> {
    return bridgeCall({ op: 'openPath', path: p }).then((r) => (r.ok ? '' : r.error ?? 'Could not open.'));
  },
  showItemInFolder(): void {},
};

export const clipboard = {
  writeText(text: string): void { fireAndForget({ op: 'copy', text }, 'copy to clipboard'); },
};

interface SaveOpts { defaultPath?: string }
interface OpenOpts { filters?: unknown; properties?: string[] }

export const dialog = {
  /** Android: files go to the app's export folder (shared later from the UI). */
  async showSaveDialog(a: unknown, b?: SaveOpts): Promise<{ canceled: boolean; filePath?: string }> {
    const opts = (b ?? a) as SaveOpts;
    const r = await bridgeCall({ op: 'exportPath', name: opts?.defaultPath ?? 'export.txt' });
    return r.ok && typeof r.path === 'string' ? { canceled: false, filePath: r.path } : { canceled: true };
  },
  async showOpenDialog(a: unknown, b?: OpenOpts): Promise<{ canceled: boolean; filePaths: string[] }> {
    void (b ?? a);
    const r = await bridgeCall({ op: 'pickFile' }, 300_000);
    return r.ok && typeof r.path === 'string' ? { canceled: false, filePaths: [r.path] } : { canceled: true, filePaths: [] };
  },
};

export const BrowserWindow = {
  getFocusedWindow: (): null => null,
  getAllWindows: (): never[] => [],
};

export class Notification {
  static isSupported(): boolean { return true; }
  constructor(private readonly opts: { title?: string; body?: string; silent?: boolean }) {}
  on(): this { return this; }
  show(): void { fireAndForget({ op: 'notify', title: this.opts.title ?? 'Devnet dVPN', body: this.opts.body ?? '', silent: !!this.opts.silent }, 'notification'); }
}

export const nativeImage = { createFromPath: (): object => ({}), createEmpty: (): object => ({}) };
export const nativeTheme = { shouldUseDarkColors: false, on(): void {} };
export const session = { defaultSession: { setPermissionRequestHandler(): void {} } };
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString(): Buffer { throw new Error('safeStorage is not used on Android (wallets use Android Keystore).'); }, // copy:internal
  decryptString(): string { throw new Error('safeStorage is not used on Android (wallets use Android Keystore).'); }, // copy:internal
};
export class Tray { constructor() { throw new Error('No tray on Android (the notification is the tray).'); } }
export const Menu = { buildFromTemplate: (): object => ({}), setApplicationMenu(): void {} };

export default { ipcMain, app, shell, clipboard, dialog, BrowserWindow, Notification, nativeImage, nativeTheme, session, safeStorage, Tray, Menu };
