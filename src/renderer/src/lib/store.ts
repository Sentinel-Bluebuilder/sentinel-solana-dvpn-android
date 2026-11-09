// ─── Renderer state: one snapshot pushed by main (F5) + small UI state ───
// Components never poll; main's scheduler owns every timer.
import { create } from 'zustand';
import type { AppSnapshot, NodeView, ProbeResult, AppSettings, Result } from '../../../shared/types';
import type { IpcChannel } from '../../../shared/ipc';
import { lockdownView } from '../../../core/session/state';

/** The system's "Block connections without VPN" setting (Android only; false elsewhere or unreadable). */
const lockdownOn = (): boolean => {
  try {
    return window.api?.android?.vpnSystemState().lockdown === true;
  } catch (err) {
    console.warn('vpn system state unreadable', err);
    return false;
  }
};

export interface Toast { id: number; kind: 'info' | 'success' | 'warn' | 'error'; message: string }

interface UiState {
  snap: AppSnapshot | null;
  nodes: NodeView[];
  probeProgress: { done: number; total: number } | null;
  settings: AppSettings | null;
  toasts: Toast[];
  setSnap(s: AppSnapshot): void;
  setNodes(n: NodeView[]): void;
  setProbe(addr: string, p: ProbeResult, done: number, total: number): void;
  setSettings(s: AppSettings): void;
  toast(kind: Toast['kind'], message: string): void;
  dismiss(id: number): void;
}

let toastId = 0;

export const useApp = create<UiState>((set) => ({
  snap: null,
  nodes: [],
  probeProgress: null,
  settings: null,
  toasts: [],
  // Android lockdown holds traffic while reconnecting whatever the kill switch says (the OS, not dvpnd).
  setSnap: (snap) => set({ snap: { ...snap, conn: lockdownView(snap.conn, lockdownOn()) } }),
  setNodes: (nodes) => set({ nodes, probeProgress: null }),
  setProbe: (addr, p, done, total) => set((s) => ({
    nodes: s.nodes.map((n) => (n.address === addr ? { ...n, probe: p } : n)),
    probeProgress: done >= total ? null : { done, total },
  })),
  setSettings: (settings) => set({ settings }),
  toast: (kind, message) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** invoke + unwrap Result; failures become an error toast and a thrown Error carrying code/action. */
export async function call<T = unknown>(channel: IpcChannel, payload?: unknown, { quiet = false } = {}): Promise<T> {
  const r = await window.api.invoke<Result<T> | T>(channel, payload);
  if (r && typeof r === 'object' && 'ok' in (r as object)) {
    const res = r as Result<T>;
    if (!res.ok) {
      if (!quiet) useApp.getState().toast('error', res.error ?? 'Something went wrong.');
      throw Object.assign(new Error(res.error ?? 'failed'), { code: res.code, action: res.action });
    }
    return res.data as T;
  }
  return r as T;
}

export function bindEvents(): () => void {
  const { EVENTS } = window.api;
  const offs = [
    window.api.on<AppSnapshot>(EVENTS.STATE, (s) => useApp.getState().setSnap(s)),
    window.api.on<NodeView[]>(EVENTS.NODES, (n) => useApp.getState().setNodes(n)),
    window.api.on<{ address: string; probe: ProbeResult; done: number; total: number }>(EVENTS.PROBE, (e) => useApp.getState().setProbe(e.address, e.probe, e.done, e.total)),
    window.api.on<{ kind: Toast['kind']; message: string }>(EVENTS.TOAST, (t) => useApp.getState().toast(t.kind, t.message)),
  ];
  return () => offs.forEach((o) => o());
}
