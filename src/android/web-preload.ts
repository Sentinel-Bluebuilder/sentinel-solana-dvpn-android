// ─── WebView preload: window.api for the Android renderer ───
// Same shape as src/preload/index.ts (Electron). Bundled to out/android/web-preload.js and run by
// the Kotlin shell before the renderer's own scripts (WebViewCompat.addDocumentStartJavaScript).
// Calls go to Kotlin through the `DdvNative` JavaScript interface, which writes them to the
// Node main process; replies and events come back through window.__ddv.
import { IPC, EVENTS, TIERS, type IpcChannel } from '../shared/ipc';

interface Native {
  invoke(id: number, channel: string, payloadJson: string): void;
  visible(shown: boolean): void;
  openVpnSettings(): void;
  notificationsAllowed(): boolean;
  vpnSystemState(): string;
  welcomed(): boolean;
  markWelcomed(): void;
  openNotificationSettings(): void;
  setSecure?(on: boolean): void; // optional: an older shell without it just shows the card unprotected
}

declare global {
  interface Window {
    DdvNative?: Native;
    __ddv?: { reply(id: number, json: string): void; event(channel: string, json: string): void };
  }
}

const native = window.DdvNative;
const allowed = new Set<string>(Object.keys(TIERS));
const events = new Set<string>(Object.values(EVENTS));
const pending = new Map<number, (v: unknown) => void>();
const listeners = new Map<string, Set<(p: unknown) => void>>();
// Call ids must not repeat across page loads: the engine outlives the page (renderer rebuilt,
// activity recreated), and a reply to the old page's call would resolve the new page's call with
// the same id with the wrong result (Q0317). Start each page at its load time (µs; < 2^53).
let nextId = Date.now() * 1000;

window.__ddv = {
  reply(id, json) {
    const done = pending.get(id);
    if (!done) return;
    pending.delete(id);
    done(JSON.parse(json));
  },
  event(channel, json) {
    const set = listeners.get(channel);
    if (!set) return;
    const payload = JSON.parse(json) as unknown;
    for (const cb of set) cb(payload);
  },
};

const api = {
  IPC,
  EVENTS,
  platform: 'android' as const,
  /** Android-only screens (no IPC: these are the phone's own settings pages). */
  android: {
    openVpnSettings(): void { native?.openVpnSettings(); },
    notificationsAllowed(): boolean { return native ? native.notificationsAllowed() : true; },
    openNotificationSettings(): void { native?.openNotificationSettings(); },
    welcomed(): boolean { return native ? native.welcomed() : false; },
    markWelcomed(): void { native?.markWelcomed(); },
    /** FLAG_SECURE on the window: no screenshot, screen recording or Recents thumbnail while on (recovery phrase). */
    setSecure(on: boolean): void { native?.setSecure?.(on); },
    vpnSystemState(): { alwaysOn?: boolean; lockdown?: boolean } {
      try { return native ? JSON.parse(native.vpnSystemState()) as { alwaysOn?: boolean; lockdown?: boolean } : {}; } catch (err) { console.warn('vpn system state unreadable', err); return {}; }
    },
  },
  invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<T> {
    if (!allowed.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    if (!native) return Promise.reject(new Error('The app bridge is not available.'));
    const id = nextId++;
    return new Promise<T>((resolve) => {
      pending.set(id, resolve as (v: unknown) => void);
      native.invoke(id, channel, JSON.stringify(payload ?? null));
    });
  },
  on<T = unknown>(channel: string, cb: (payload: T) => void): () => void {
    if (!events.has(channel)) throw new Error(`blocked event ${channel}`); // copy:internal
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    const fn = cb as (p: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  },
};

(window as unknown as { api: typeof api }).api = Object.freeze(api);
document.addEventListener('visibilitychange', () => native?.visible(document.visibilityState === 'visible'));
