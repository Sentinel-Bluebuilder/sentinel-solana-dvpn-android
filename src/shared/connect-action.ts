// ─── Where the button under a failed or stopped connect goes ───
// Each connect error carries an action (core/session/state.ts connectErrorCopy). Home turns it into
// one button that does what the words say: retry the same server, or go to the screen that fixes it.

export type ConnectActionTarget = 'same-node' | 'nodes' | 'wallet' | 'plans' | 'settings' | 'diagnostics' | 'restore' | 'disconnect';

export interface ConnectActionButton { target: ConnectActionTarget; label: string }

/** null = no button (internal codes, or no action). */
export function connectActionButton(action: string | null | undefined): ConnectActionButton | null {
  const a = String(action ?? '').trim();
  if (!a || a === 'adopt' || a === 'unknown') return null;
  if (/restore.network/i.test(a)) return { target: 'restore', label: 'Restore network' };
  // A session is already running (session-active): end it. Before the /connect/ rule below.
  if (/^disconnect/i.test(a)) return { target: 'disconnect', label: 'Disconnect' };
  if (/fund|top up|wallet|set up device/i.test(a)) return { target: 'wallet', label: 'Open Wallet' };
  if (/plan/i.test(a)) return { target: 'plans', label: 'Plans' };
  if (/settings/i.test(a)) return { target: 'settings', label: 'Settings' };
  if (/diagnostics|report/i.test(a)) return { target: 'diagnostics', label: 'Diagnostics' };
  // Another server or protocol, or one you already use: the server list.
  if (/another|pick a server/i.test(a)) return { target: 'nodes', label: 'Servers' };
  // Connect again, Reconnect, Retry, a new or larger deposit, stream payment: the same server again.
  if (/connect|retry|deposit|stream/i.test(a)) return { target: 'same-node', label: /connect again/i.test(a) ? 'Connect again' : 'Try again' };
  return { target: 'nodes', label: 'Servers' };
}
