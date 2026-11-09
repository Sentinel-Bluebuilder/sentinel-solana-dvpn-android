// ─── Connect on launch (F21, opt-in) ───
// Runs at most once per app start, only when the user turned it on. It never
// resumes after a crash: if the daemon still holds a session it is adopted
// instead, and a leftover block from a previous run (a tunnel still up, or no internet
// with no session: the Restore network warning) stops it. The check is awaited here, not
// left to the parallel onDaemonChange run, which could finish after we connect (C17).
// Picks the same server quick connect would and uses the default amount.
import { snapshot } from '../app-state';
import { getSettings } from '../system/settings';
import { daemonReady } from '../daemon/manager';
import { adoptRunningSession, checkLeftoverBlock, connect } from './connection';
import { nodeViews, refreshNodes } from './nodes';
import { refreshWallet } from './wallet';
import { pickQuickNode } from '../../shared/quick-pick';
import { log } from '../logger';

let tried = false;

export async function maybeAutoConnect(): Promise<void> {
  const s = getSettings();
  if (tried || !s.autoConnect) return;
  tried = true;
  try {
    await daemonReady(20_000);
    await adoptRunningSession({ applyProxy: true });
    const snap = snapshot();
    if (snap.session || !snap.daemon.reachable || snap.lastCloseMessage?.action) return;
    if (snap.conn.restoreNetwork || (await checkLeftoverBlock()) || snapshot().conn.restoreNetwork) {
      log.info('auto-connect: skipped, the network needs restoring first');
      return;
    }
    const w = await refreshWallet();
    if (!w?.ready) return;
    const list = nodeViews().some((n) => n.probe) ? nodeViews() : await refreshNodes();
    const node = pickQuickNode(list, s.preferredCountry);
    if (!node) { log.info('auto-connect: no online server'); return; }
    const basis = s.defaultBasis === 'per_hour' && BigInt(node.pricePerHour || '0') > 0n ? 'per_hour' : BigInt(node.pricePerGb || '0') > 0n ? 'per_gb' : 'per_hour';
    log.info('auto-connect', { node: node.address, basis });
    await connect({ node: node.address, basis, units: basis === 'per_hour' ? s.defaultHours : s.defaultGb, confirmed: true });
  } catch (err) {
    log.warn('auto-connect skipped', { err: (err as Error).message });
  }
}
