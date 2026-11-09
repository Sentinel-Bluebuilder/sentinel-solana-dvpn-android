// ─── Disconnect: stop our session, or the one dvpnd runs now ───
import { DaemonError, type DaemonClient, type StopResult } from '../../core/daemon/client';
import { daemon } from '../daemon/manager';
import { log } from '../logger';

/**
 * Stop the session we know, or whatever the daemon runs now. When the node stops answering,
 * dvpnd reconnects under a NEW session id, so the id we hold is "not found" while a tunnel is
 * still up (live: kernel-7 VM, 2026-10-21 21:18). An empty id stops the current session and
 * releases a held kill switch; "not found" for that too means nothing is left to stop.
 */
export async function stopLiveOrCurrent(id: string, d: Pick<DaemonClient, 'stopSession'> = daemon(), opts: { keepKillSwitch?: boolean } = {}): Promise<StopResult> {
  try {
    return await d.stopSession(id, opts);
  } catch (err) {
    if (!(err instanceof DaemonError) || err.kind !== 'not-found' || !id) throw err;
    log.warn('session id gone (dvpnd reconnected); stopping the current session', { id });
    try {
      return await d.stopSession('', opts);
    } catch (err2) {
      if (err2 instanceof DaemonError && err2.kind === 'not-found') return { session: null, killSwitchReleased: false, dnsRevertFailed: false };
      throw err2;
    }
  }
}

