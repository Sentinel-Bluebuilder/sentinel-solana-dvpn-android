// ─── Preload: the only bridge between renderer and main ───
// Exposes typed invoke/subscribe over the IPC enum. No Node APIs, no secrets.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, EVENTS, TIERS, type IpcChannel } from '../shared/ipc';

const allowed = new Set<string>(Object.keys(TIERS));
const events = new Set<string>(Object.values(EVENTS));

const api = {
  IPC,
  EVENTS,
  invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<T> {
    if (!allowed.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, payload) as Promise<T>;
  },
  on<T = unknown>(channel: string, cb: (payload: T) => void): () => void {
    if (!events.has(channel)) throw new Error(`blocked event ${channel}`); // copy:internal
    const listener = (_e: unknown, p: T): void => cb(p);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
