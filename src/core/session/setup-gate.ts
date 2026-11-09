// ─── Setup gate: when the setup screen may take the whole window ───
export type SetupStep = 'wallet' | 'device' | 'permission' | 'service' | 'done';

/** The device pays its own transaction fees; below this it cannot start a session. */
export const DEVICE_MIN_LAMPORTS = 5_000_000;

/** Why the wallet is not ready, so the words match the fix. Only device SOL short is common after
 *  setup: test deposits eat it as rent (test-host 2026-10-22: 0.0043 SOL said "permission"). */
export function notReadyReason(w: { grant: unknown; delegated: string; deviceLamports: number } | null | undefined): 'permission' | 'device-sol' {
  if (!w || !w.grant || BigInt(w.delegated || '0') === 0n) return 'permission';
  return w.deviceLamports < DEVICE_MIN_LAMPORTS ? 'device-sol' : 'permission';
}

const sol = (lamports: number): string => (lamports / 1e9).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

/** One line for a device short of fee SOL: what it has, what it needs. */
export function deviceSolCopy(lamports: number): string {
  return `This device needs a little SOL for transaction fees (has ${sol(lamports)}, needs ${sol(DEVICE_MIN_LAMPORTS)}).`;
}

/** Once someone is set up, a step that goes missing later (the service stops answering for a
 *  moment, a balance read fails) must not swap the whole window for setup: the menu, the session
 *  and Disconnect would vanish mid-session (VM test-host 2026-10-22, WireGuard split run). Setup
 *  takes the window only on first use and after logout; otherwise the main layout shows a banner.
 *  A device already registered on chain counts as set up, so a slow service start at launch shows
 *  the banner too, not "Install service".
 *  deviceUnknown: the service is not answering AND the wallet has not been read yet, so "no device"
 *  only means "not read yet". Right after an app restart that showed "Create this device's key" to
 *  a set-up user; the banner says the device could not be read yet instead. */
export function showSetupScreen(step: SetupStep, setupSeen: boolean, deviceOnChain: boolean, deviceUnknown = false): boolean {
  if (step === 'done') return false;
  if (step === 'wallet') return true;
  if (setupSeen) return false;
  if (step === 'device' && deviceUnknown) return false;
  return !(step === 'service' && deviceOnChain);
}

/**
 * deviceUnknown for showSetupScreen: the service is not answering and the wallet has not been read
 * yet, after an app restart (Q0330). Not during setup in this run (Q0386): right after "Create a new
 * wallet" on a fresh install the service is still starting and the wallet is not read yet, and taking
 * that as "unknown" swapped the setup screen for the main layout, unmounting the recovery-phrase card
 * (the phrase was lost and the user could never back the wallet up).
 */
export function deviceUnread(daemonReachable: boolean, walletRead: boolean, setupThisRun: boolean): boolean {
  return !setupThisRun && !daemonReachable && !walletRead;
}

/** The banner for a step lost after setup: what is wrong and where to fix it. */
export function lostSetupCopy(step: SetupStep, w?: { grant: unknown; delegated: string; deviceLamports: number } | null): { text: string; screen: 'diagnostics' | 'wallet' } | null {
  if (step === 'service') return { text: 'The VPN service is not answering. The app keeps retrying; connecting waits until it answers.', screen: 'diagnostics' };
  if (step === 'permission' && w && notReadyReason(w) === 'device-sol') return { text: `${deviceSolCopy(w.deviceLamports)} Top it up in Wallet.`, screen: 'wallet' };
  if (step === 'permission') return { text: 'The spending permission needs attention before the next connect.', screen: 'wallet' };
  if (step === 'device') return { text: 'This device could not be read from the service or the chain yet.', screen: 'diagnostics' };
  return null;
}

