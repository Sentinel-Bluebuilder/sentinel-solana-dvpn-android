// ─── Desktop notifications (F21.3) ───
// Toasts are mirrored to the OS only while the window is hidden or unfocused,
// and only for things the user must know: drops, failures, refunds, low funds.
import { Notification, type BrowserWindow } from 'electron';
import { getSettings } from './settings';
import { log } from '../logger';

const KINDS = new Set(['warn', 'error', 'success']);
let last = '';
let lastAt = 0;

export function notifyIfHidden(t: { kind: string; message: string }, win: BrowserWindow | null): void {
  // A UI smoke run never raises an OS notification (it runs unfocused, off-screen).
  if (process.env.DVPN_UI_SMOKE) return;
  if (!KINDS.has(t.kind) || !getSettings().notifications || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
  if (t.message === last && Date.now() - lastAt < 60_000) return; // no repeats within a minute
  last = t.message; lastAt = Date.now();
  try {
    const n = new Notification({ title: 'Devnet dVPN', body: t.message, silent: t.kind === 'success' });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  } catch (err) {
    log.warn('notification failed', { err: (err as Error).message });
  }
}
