// ─── VPN-service settings: read once, edit a draft, apply with one administrator prompt ───
// Shared by Settings and the Kill switch page. Applying restarts the service (ends a session).
import { useEffect, useRef, useState } from 'react';
import { call, useApp } from './store';
import type { DaemonSettings } from '../../../core/daemon/config';
import { changedKeys, mergeLoaded } from '../../../core/daemon/draft';

export interface DaemonState { readable: boolean; settings: Partial<DaemonSettings> }

export function useDaemonSettings() {
  const [daemon, setDaemon] = useState<DaemonState | null>(null);
  const [draft, setDraftState] = useState<Partial<DaemonSettings>>({});
  const [applying, setApplying] = useState(false);
  // Keys the user edited since the last read: the read keeps them instead of overwriting them.
  const touched = useRef(new Set<string>());

  const setDraft = (next: Partial<DaemonSettings>): void => {
    setDraftState((prev) => {
      for (const k of changedKeys(prev, next)) touched.current.add(k);
      return next;
    });
  };
  const load = async (opts: { keepEdits?: boolean } = {}): Promise<DaemonState> => {
    const d = await call<DaemonState>(window.api.IPC.DAEMON_SETTINGS_GET);
    setDaemon(d);
    if (opts.keepEdits) setDraftState((prev) => mergeLoaded(d.settings, prev, touched.current));
    else setDraftState(d.settings);
    touched.current = new Set();
    return d;
  };
  useEffect(() => {
    load({ keepEdits: true }).catch((err) => { console.warn('daemon settings read failed', err); setDaemon({ readable: false, settings: {} }); });
  }, []);

  const dirty = !!daemon && JSON.stringify(draft) !== JSON.stringify(daemon.settings);
  const apply = async (): Promise<void> => {
    if (!daemon) return;
    setApplying(true);
    try {
      await call(window.api.IPC.DAEMON_SETTINGS_APPLY, { ...daemon.settings, ...draft });
      await load();
      useApp.getState().toast('success', 'VPN service settings applied.');
    } catch (err) {
      console.warn('apply failed', err);
    } finally {
      setApplying(false);
    }
  };
  const reset = (): void => { if (daemon) { setDraftState(daemon.settings); touched.current = new Set(); } };
  return { daemon, draft, setDraft, dirty, applying, apply, reset };
}
