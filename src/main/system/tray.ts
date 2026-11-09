// ─── Tray (F21) — status + connect/disconnect, pattern from node-manager tray.ts ───
import { Tray, Menu, nativeImage, app, type BrowserWindow } from 'electron';
import { snapshot } from '../app-state';
import { disconnect } from '../services/connection';
import { connectActionButton } from '../../shared/connect-action';
import { EVENTS } from '../../shared/ipc';
import { log } from '../logger';

let tray: Tray | null = null;
let winRef: (() => BrowserWindow | null) | null = null;
let quitting = false;

export const isQuitting = (): boolean => quitting;
export const markQuitting = (): void => { quitting = true; };
export const trayActive = (): boolean => !!tray;

// The app mark (Solana's three bars) drawn in code so a missing asset can never hide the tray:
// the Solana gradient when connected, grey when not.
const BARS = 'M64.6 237.9a13 13 0 0 1 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8A13.4 13.4 0 0 1 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1a13 13 0 0 0-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7a13 13 0 0 0 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z';
function icon(connected: boolean): Electron.NativeImage {
  const fill = connected ? 'url(#g)' : '#8a8a9a';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -43 397 397"><defs><linearGradient id="g" x1="360" y1="-37" x2="141" y2="383" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#14F195"/><stop offset="1" stop-color="#9945FF"/></linearGradient></defs><path d="${BARS}" fill="${fill}"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

export function createTray(win: () => BrowserWindow | null): void {
  try {
    tray = new Tray(icon(false));
  } catch (err) {
    log.warn('tray unavailable', err);
    return;
  }
  winRef = win;
  const show = (): void => { const w = win(); if (w) { w.show(); w.focus(); } };
  tray.on('click', show);
  updateTray();
}

export function updateTray(): void {
  if (!tray) return;
  // Built from the window each time: state updates call this with no arguments, and "Open" used to
  // lose its handler after the first one.
  const show = (): void => { const w = winRef?.(); if (w) { w.show(); w.focus(); } };
  const s = snapshot();
  const connected = s.conn.phase === 'connected';
  tray.setImage(icon(connected));
  tray.setToolTip(`Devnet dVPN — ${s.conn.title}`);
  // The last connect that failed or was stopped: its next step opens Home, where that button is.
  // It never connects from here: a connect pays a deposit, so it goes through the confirm sheet.
  const last = !s.session ? s.lastConnectError : null;
  const next = last ? connectActionButton(last.action) : null;
  const openHome = (): void => {
    show();
    winRef?.()?.webContents.send(EVENTS.GO, 'home');
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: s.conn.title, enabled: false },
    ...(last ? [{ label: last.code === 'cancelled' ? 'Connecting stopped' : 'Last connect failed', enabled: false }] : []),
    ...(next ? [{ label: `${next.label}…`, click: openHome }] : []),
    { type: 'separator' },
    { label: 'Open', click: show },
    { label: 'Disconnect', enabled: !!s.session, click: () => void disconnect() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
