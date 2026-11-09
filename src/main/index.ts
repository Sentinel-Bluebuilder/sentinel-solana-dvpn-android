// ─── Electron entry (F21, F24) ───
// Order: single-instance lock → host/runtime → crash-safe cleanup (system proxy
// left behind by a crash) → IPC → window → daemon link → scheduler.
// A running daemon session is adopted, never auto-started after a crash.
import { app, BrowserWindow, session, shell } from 'electron';
import path from 'node:path';
import { initRuntime, APP_DIR_NAME } from './runtime';
import { safeStorageKeyStore } from './wallet/electron-keystore';
import { attachGlobalHandlers, log } from './logger';
import { registerIpc } from './ipc';
import { startDaemonLink, stopDaemonLink, onDaemonChange } from './daemon/manager';
import { startScheduler, stopScheduler, setHidden } from './scheduler';
import { adoptRunningSession, checkLeftoverBlock, disconnect } from './services/connection';
import { snapshot } from './app-state';
import './ks-title-wire';
import { restoreProxyOnStartup, clearSystemProxy } from './system/proxy';
import { getSettings, onSettingsChanged } from './system/settings';
import { maybeAutoConnect } from './services/auto-connect';
import { createTray, updateTray, isQuitting, markQuitting, trayActive, destroyTray } from './system/tray';
import { notifyIfHidden } from './system/notify';
import { EVENTS } from '../shared/ipc';
import { cliKeyStore } from '../cli/keystore';
import { runUiSmoke, prepareUiSmoke } from './dev/ui-smoke';

// Test-only overrides (same names as the CLI): a scratch data dir and a read-only
// key file let e2e runs drive the real app without touching the user's profile.
const TEST_DATA_DIR = process.env.DVPN_DATA_DIR || '';
const TEST_KEYFILE = process.env.DVPN_KEYFILE || '';

if (process.env.DVPN_UI_SMOKE) prepareUiSmoke();
app.setName(APP_DIR_NAME);
app.setPath('userData', TEST_DATA_DIR || path.join(app.getPath('appData'), APP_DIR_NAME));

let win: BrowserWindow | null = null;

// A second launch must do nothing but hand over: app.quit() is async, and its startup
// would otherwise still run (restoreProxyOnStartup could clear the first copy's live proxy).
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    log.info('second launch: showing the running window instead');
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

attachGlobalHandlers();

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'Devnet dVPN',
    backgroundColor: '#060608',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  // A UI smoke run never takes focus or appears on screen: it opens off-screen, without a
  // taskbar button, and shows inactive (owner 2026-10-22: test windows popped up over a game).
  if (process.env.DVPN_UI_SMOKE) {
    w.setSkipTaskbar(true);
    w.setFocusable(false);
    w.setPosition(-32000, -32000);
    w.on('ready-to-show', () => w.showInactive());
  } else {
    // Started at sign-in (--hidden) with close-to-tray on: stay in the tray, as on Linux and
    // macOS (builder-kb review). Without a tray to fall back to, show the window as before.
    const hidden = process.argv.includes('--hidden') && getSettings().closeToTray;
    w.on('ready-to-show', () => { if (!hidden) w.show(); });
  }
  // ─── Crash visibility (RELEASE-TEST-PLAN Phase 6): every renderer death or hang is logged,
  // and a crashed screen reloads once instead of staying blank. The VPN session lives in the
  // service, so a reload never drops it.
  let reloads = 0;
  w.webContents.on('render-process-gone', (_e, d) => {
    log.error('renderer gone', { reason: d.reason, exitCode: d.exitCode });
    if (d.reason !== 'clean-exit' && reloads++ < 1 && !w.isDestroyed()) w.webContents.reload();
  });
  w.on('unresponsive', () => log.warn('window unresponsive'));
  w.on('responsive', () => log.info('window responsive again'));
  w.webContents.on('preload-error', (_e, p, err) => log.error('preload error', { path: p, err: err.message }));
  w.on('close', (e) => {
    if (isQuitting() || !getSettings().closeToTray || !trayActive()) return;
    e.preventDefault();
    w.hide();
  });
  w.on('hide', () => setHidden(true));
  w.on('show', () => setHidden(false));
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'));
  return w;
}

app.on('child-process-gone', (_e, d) => {
  if (d.reason !== 'clean-exit') log.error('child process gone', { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name });
});

app.whenReady().then(async () => {
  if (!primary) return;
  process.env.DVPN_APP_VERSION ??= app.getVersion(); // read by the in-app CLI `version`
  initRuntime({
    name: 'app',
    // electron-builder extraResources copies resources/ to <resourcesPath>/resources.
    resourcesDir: app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(app.getAppPath(), 'resources'),
    dataDir: app.getPath('userData'),
    keyStore: TEST_KEYFILE ? cliKeyStore(app.getPath('userData'), TEST_KEYFILE) : safeStorageKeyStore(app.getPath('userData')),
    emit: (channel, payload) => {
      for (const b of BrowserWindow.getAllWindows()) if (!b.isDestroyed()) b.webContents.send(channel, payload);
      if (channel === EVENTS.STATE) updateTray();
      if (channel === EVENTS.TOAST) notifyIfHidden(payload as { kind: string; message: string }, win);
    },
  });
  log.info('app start', { version: app.getVersion(), packaged: app.isPackaged });
  // No remote content, no permission prompts.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  await restoreProxyOnStartup().catch((err) => log.error('proxy restore on start failed', err));
  registerIpc();
  win = createWindow();
  if (process.env.DVPN_UI_SMOKE) runUiSmoke(win, process.env.DVPN_UI_SMOKE);
  createTray(() => win);
  if (!TEST_DATA_DIR) {
    app.setLoginItemSettings({ openAtLogin: getSettings().startWithOs, args: ['--hidden'] });
    onSettingsChanged((st) => app.setLoginItemSettings({ openAtLogin: st.startWithOs, args: ['--hidden'] }));
  }
  startDaemonLink();
  // After the daemon link settles: adopt its session, else look for a leftover block (F14.3).
  onDaemonChange(() => { void adoptRunningSession({ applyProxy: true, startedElsewhere: true }).then(() => checkLeftoverBlock()); });
  startScheduler(); // its first tick reads the wallet; a second read here doubled every startup call (T5)
  if (!process.env.DVPN_UI_SMOKE) void maybeAutoConnect();
}).catch((err) => log.error('startup failed', err));

// Quit = stop the session and put the system proxy back first (F12). Nothing may be
// left steering or blocking traffic with no app watching it. Capped at 10 s so a
// stuck daemon can never stop the app from closing.
let cleanedUp = false;
app.on('before-quit', (e) => {
  markQuitting();
  if (cleanedUp) return;
  e.preventDefault();
  cleanedUp = true;
  stopScheduler();
  const cleanup = (async () => {
    if (snapshot().session) await disconnect();
    await clearSystemProxy();
  })().catch((err) => log.error('quit cleanup failed', err));
  void Promise.race([cleanup, new Promise((r) => setTimeout(r, 10_000))]).finally(() => {
    stopDaemonLink();
    destroyTray();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
