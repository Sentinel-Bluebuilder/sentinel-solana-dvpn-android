// ─── Reconnecting title vs the saved kill switch ───
// Imported once by the app and the CLI entry points (not by services, so unit tests that mock
// app-state never load it). With the kill switch off the Reconnecting title claims no block.
import { setKillSwitchOffCheck } from './app-state';
import { getDaemonSettings } from './daemon/settings';
import { log } from './logger';

setKillSwitchOffCheck(() => {
  try {
    return getDaemonSettings().settings.killSwitch === 'off';
  } catch (err) {
    log.debug('kill switch setting unreadable; Reconnecting keeps the blocked title', { err: (err as Error).message });
    return false;
  }
});
