// ─── Session state machine the user sees (F11) ───
// Source of truth: sentinel-solana docs/17 (states, 8 close reasons) and docs/29
// §3–§5 (copy + actions). Daemon wire statuses: open | active | closing | ended | closed.
// Reconnect is the daemon's job (5 attempts, 2 s doubling — D6); the app only
// labels it and keeps Stop visible.

export type ConnPhase =
  | 'idle'          // Not connected
  | 'preflight'     // zero-cost checks before any payment
  | 'paying'        // opening a channel on chain (escrow shown)
  | 'connecting'    // position open, tunnel coming up
  | 'checking'      // tunnel up, dvpnd checking traffic passes before calling it connected (Q0357)
  | 'connected'     // Protected
  | 'reconnecting'  // lost, kill switch holding traffic
  | 'disconnecting'
  | 'error';

export interface ConnView {
  phase: ConnPhase;
  title: string;
  detail: string;
  canConnect: boolean;
  canCancel: boolean;
  canDisconnect: boolean;
  canStop: boolean; // always true while traffic might be blocked
  restoreNetwork: boolean;
}

export function viewFor(phase: ConnPhase, detail = ''): ConnView {
  const base = { phase, detail, canConnect: false, canCancel: false, canDisconnect: false, canStop: false, restoreNetwork: false };
  switch (phase) {
    case 'idle': return { ...base, title: 'Not connected', canConnect: true };
    case 'preflight': return { ...base, title: 'Checking…', canCancel: true };
    case 'paying': return { ...base, title: 'Paying deposit…', canCancel: true };
    case 'connecting': return { ...base, title: 'Connecting…', canCancel: true };
    case 'checking': return { ...base, title: 'Checking the connection…', detail: detail || 'Making sure your traffic passes through the server before calling it protected.', canCancel: true };
    case 'connected': return { ...base, title: 'Protected', canDisconnect: true };
    case 'reconnecting': return { ...base, title: RECONNECTING_TITLE.blocked, canStop: true };
    case 'disconnecting': return { ...base, title: 'Disconnecting…' };
    case 'error': return { ...base, title: 'Connection failed', canConnect: true };
    default: return { ...base, title: String(phase) };
  }
}

/** The Reconnecting title. With the kill switch on dvpnd holds traffic until the VPN is back; with it
 *  off (dvpnd final3, DIR 11-08: final2 wrongly armed a block) the routes go direct while it
 *  reconnects. Same copy on every app (DIR). */
export const RECONNECTING_TITLE = {
  blocked: 'Reconnecting — internet blocked to protect you',
  direct: 'Reconnecting… traffic is going direct (kill switch is off)',
} as const;
/** Android: with the system's "Block connections without VPN" (lockdown) on, the OS holds traffic
 *  while dvpnd reconnects even with the app's kill switch off, so the title keeps the block (QA). */
export function lockdownView(view: ConnView, lockdown: boolean): ConnView {
  if (!lockdown || view.phase !== 'reconnecting' || view.title !== RECONNECTING_TITLE.direct) return view;
  return { ...view, title: RECONNECTING_TITLE.blocked };
}
export function reconnectingView(view: ConnView, killSwitchOff: boolean): ConnView {
  if (view.phase !== 'reconnecting' || !killSwitchOff) return view;
  return { ...view, title: RECONNECTING_TITLE.direct };
}

/** Daemon session status (+error) → phase. */
export function phaseFromDaemon(status: string, error = ''): ConnPhase {
  switch (status) {
    case 'open': return 'connecting';
    case 'checking': return 'checking'; // dvpnd: tunnel up, data-plane check running (never "connected")
    case 'active': return error ? 'reconnecting' : 'connected';
    case 'closing': return 'disconnecting';
    case 'ended':
    case 'closed': return 'idle';
    default: return 'connecting';
  }
}

// ─── Why a session ended (docs/29 §4) ───
export interface Copy { message: string; action: string | null }

const CLOSE_REASONS: Array<[RegExp, Copy]> = [
  [/closed by client|stopped by user/i, { message: 'Disconnected.', action: null }],
  [/credit exhausted|escrow exhausted/i, { message: 'Your deposit ran out.', action: 'Add funds and reconnect' }],
  // Q0366: nothing passed through the tunnel and one redial failed.
  [/server stopped working/i, { message: 'The connection to this server stopped working.', action: 'Pick another server' }],
  [/\bidle\b|connection lost/i, { message: 'Connection to the server was lost.', action: 'Reconnect' }],
  [/closed by operator/i, { message: 'The server ended the session.', action: 'Pick another server' }],
  [/position closed on chain/i, { message: 'The payment channel was closed.', action: 'Reconnect with a new deposit' }],
  [/position closing/i, { message: 'Your deposit is closing, so the session ended.', action: 'Connect with a new deposit' }],
  [/close grace elapsed/i, { message: "The channel's closing period ended.", action: null }],
  [/no enforcer|retrying close|switching servers/i, { message: 'Disconnected.', action: null }],
  // dvpnd cf4c372 reasons (standards audit A2-14; copy from the builder guide's errors chapter §5).
  [/data cap reached/i, { message: "You've used this plan's data.", action: 'View plans' }],
  [/ticket expired/i, { message: 'Your plan access expired. Connect again to renew it.', action: 'Reconnect' }],
  [/lease not funded/i, { message: 'This server is no longer on your plan right now.', action: 'Pick another server' }],
  [/\breplaced\b/i, { message: 'This session was replaced by a newer one.', action: null }],
  // Q0195 (dvpnd e3d60d9): the server is ahead while this device's counter stopped rising (a lossy
  // link, or a server billing data it never delivered: the app cannot tell which).
  [/local counter stalled/i, { message: 'The connection to this server is losing data, so the app stopped paying for data this device did not receive.', action: 'Pick another server' }],
  [/node overcharging/i, { message: 'The server counted more data than this device did, so the app stopped paying it.', action: 'Pick another server' }],
  [/service stats unavailable/i, { message: 'The tunnel stopped responding, so the session ended. The unused deposit comes back when it closes.', action: 'Reconnect' }],
  [/daemon restarted/i, { message: 'The VPN service restarted.', action: 'Reconnect' }],
  [/daemon stopping/i, { message: 'The VPN service is stopping.', action: null }],
];

export function closeReasonCopy(reason: string): Copy {
  for (const [re, copy] of CLOSE_REASONS) if (re.test(reason)) return copy;
  return { message: reason ? 'The session ended.' : 'Disconnected.', action: null };
}

// ─── Node API errors on Connect (docs/29 §5) ───
const NODE_ERRORS: Array<[string, Copy & { retry?: boolean; internal?: boolean }]> = [
  ['credit_exhausted', { message: 'Not enough credit left on this plan or deposit.', action: 'Add funds' }],
  ['peer_limit_reached', { message: 'Your plan allows a limited number of devices at once, or the server is full. Disconnect one first.', action: 'Pick another server' }],
  ['lease_insufficient', { message: "This server isn't available on your plan right now.", action: 'Pick another server' }],
  ['subscription_invalid', { message: "Your plan doesn't include this server, or it expired.", action: 'Pick another server' }],
  // The plan provider refused the signed ticket request as too old or from the future: this device's clock is
  // off by more than a minute (auth.VerifyTicketRequest, 60 s skew / 5 min age). Before ticket_invalid, which
  // used to hide it (Q0068: an Android emulator failed every plan connect with "couldn't give this server access").
  ['ticket_request_stale', { message: "This device's clock is wrong by more than a minute, so the plan provider refused the request. Set the date and time to automatic, then connect again. Nothing was paid.", action: 'Fix the clock' }],
  // The node could not reach the plan provider at all (dvpnd c3c8144: discovery/transport failure, 502).
  ['provider_unreachable', { message: "The plan's provider is not answering, so this server can't check your plan. Nothing was paid.", action: 'Retry later', retry: true }],
  // Shown after the retries. Usually the plan's data is already shared out to the servers you use:
  // each new server reserves a share for 24 h (provider reserveTicket, gap #78, plan-a188).
  ['ticket_invalid', { message: "Your plan couldn't give this server access. Its data may already be shared out to the servers you use, or the plan provider is not answering.", action: 'Pick a server you already use', retry: true }],
  ['unauthorized', { message: 'This device is not allowed to spend for your wallet yet.', action: 'Set up device' }],
  ['cannot cover the prepay', { message: "Deposit too small for this server's minimum.", action: 'Increase deposit' }],
  ['voucher_exceeds_escrow', { message: "Deposit too small for this server's minimum.", action: 'Increase deposit' }],
  ['channel_node_reopened', { message: 'The server restarted since your deposit was made.', action: 'Reconnect with a new deposit' }],
  ['terms_rejected', { message: 'The server refused the payment terms.', action: 'Pick another server' }],
  ['rate_limited', { message: 'The server is busy.', action: 'Retry later', retry: true }],
  ['voucher_signature_invalid', { message: 'The app could not sign the payment. Send a problem report from Diagnostics.', action: 'Report', internal: true }],
  ['mode_not_voucher', { message: 'The server expects a different payment mode. Send a problem report from Diagnostics.', action: 'Report', internal: true }],
  ['mode_not_stream', { message: 'The server expects a different payment mode. Send a problem report from Diagnostics.', action: 'Report', internal: true }],
];

/** Node API codes renamed in dvpnd cf4c372 (sentinel-go-sdk/api/error.go) → our canonical code.
 *  Old nodes still send the old names, so both match. Found by the Linux app 2026-10-21. */
export const NODE_ERROR_ALIASES: Record<string, string> = {
  invalid_ticket: 'ticket_invalid',
  invalid_subscription: 'subscription_invalid',
  lease_not_funded: 'lease_insufficient',
  channel_node_stale: 'channel_node_reopened',
  invalid_voucher_signature: 'voucher_signature_invalid',
  prepay_below_minimum: 'voucher_exceeds_escrow',
  // auth.ErrTicketRequestStale text, when a node forwards the provider's own message (Q0068)
  'ticket request is stale': 'ticket_request_stale',
};

export interface ConnectError extends Copy { code: string; retry: boolean; internal: boolean }

/** dvpnd's live session warning codes (Session.warning) → the Connect screen's banner. The same
 *  copy on every app (DIR 10-30). Unknown codes show nothing: an older app must not guess. */
/**
 * Q0366 end copy (TAN lab-q0366m): the blocked view after an unexpected end already says why and that
 * the kill switch is blocking, so the header alert ("Internet may be blocked by the kill switch…")
 * would be a second message on the same screen. True = show only the panel, with Restore network in it.
 */
export function restoreInPanel(conn: { phase: string; restoreNetwork?: boolean; title?: string; detail?: string }): boolean {
  return !!conn.restoreNetwork && conn.phase === 'error' && /kill switch/i.test(`${conn.title ?? ''} ${conn.detail ?? ''}`);
}

export const SESSION_WARNING_COPY: Readonly<Record<string, string>> = {
  'large-packets': 'This network drops large packets; some sites may not load. V2Ray or Xray usually works.',
};
export function sessionWarningCopy(code: string | null | undefined): string | null {
  return (code && SESSION_WARNING_COPY[code]) || null;
}

export function connectErrorCopy(errText: string): ConnectError {
  const t = String(errText ?? '');
  const aliased = (code: string): boolean => Object.entries(NODE_ERROR_ALIASES).some(([alias, canon]) => canon === code && t.includes(alias));
  // A disconnect while connecting: dvpnd stops at whatever step it was on and prefixes this. The user
  // asked for it, so it wins over the step's own error (Linux edge races: the catch-all, or "tunnel
  // didn't come up"). A deposit sent before the stop is not lost: it comes back when it closes.
  if (/stop requested while connecting/i.test(t)) return { code: 'cancelled', message: 'Connecting stopped because you disconnected. If a deposit was already sent, its unused part comes back when it closes (settle).', action: 'Connect again', retry: true, internal: false };
  // dvpnd started before the network was up (boot, before Wi-Fi) and is still waiting for the Solana
  // endpoint (Q0232): nothing was paid, connecting again works once the network is back.
  if (/waiting for network/i.test(t)) return { code: 'waiting-for-network', message: 'Waiting for the network. The VPN service started before this device was online and is still trying to reach the Solana network. Nothing was paid.', action: 'Retry in a moment', retry: true, internal: false };
  // The VPN service already runs a session (started from the CLI, another window, or one a test left
  // behind): dvpnd refuses before paying (test-host mx-a13 showed the catch-all for it).
  if (/a session is already active/i.test(t)) return { code: 'session-active', message: 'A VPN session is already running (started from the command line or another window). Disconnect it first, then connect again. Nothing was paid.', action: 'Disconnect', retry: false, internal: false };
  // The plan access was issued to a different wallet than the one this computer's VPN service spends
  // for (dvpnd ErrTicketOwnerMismatch, after switching wallets; Q0279 M-plan-a3a4). Retrying never helps.
  if (/ticket was issued for another owner/i.test(t)) return { code: 'ticket-other-owner', message: "This plan access belongs to another wallet than the one this computer's VPN service uses. Switch back to that wallet, or set up this computer again with the current wallet. Nothing was paid.", action: 'Set up device', retry: false, internal: false };
  // V2Ray/Xray's local SOCKS port is held by another program (edge porttaken on Linux: "failed to listen
  // TCP on 1080"). Said before the generic tunnel copy, which blamed the server.
  const busy = /failed to listen (?:TCP |UDP )?on (\d+)|address already in use|bind: address/i.exec(t);
  if (busy) return { code: 'port-in-use', message: `Another program on this computer is using ${busy[1] ? `port ${busy[1]}` : 'the local port'} that this protocol needs. Close that program, or pick a server with another protocol. The unused deposit comes back when it closes.`, action: 'Try another protocol', retry: true, internal: false };
  // L5: dvpnd could not change this computer's DNS (a container, toolbox or distrobox bind-mounts /etc/resolv.conf:
  // "rename ...: device or resource busy"). The generic copy said "Something went wrong" for a clear, fixable cause.
  if (/resolv\.conf|(?:apply(?:ing)?|setting|pointing)[^\n]*\bdns\b|\bdns\b[^\n]*(?:rename|apply)/i.test(t)) return { code: 'dns-apply', message: "The VPN couldn't change this computer's DNS settings (often a container or a locked /etc/resolv.conf). In Settings, turn off Use the VPN's DNS, then connect again. The unused deposit comes back when the session closes.", action: 'Open settings', retry: false, internal: false };
  for (const [code, c] of NODE_ERRORS) {
    if (t.includes(code) || aliased(code)) return { code, message: c.message, action: c.action, retry: !!c.retry, internal: !!c.internal };
  }
  // Daemon-side failures after the node accepted the session (found on the box rig).
  if (/executable file not found|no such file or directory.*(openvpn|v2ray|xray|hysteria|wireguard|wg)\b/i.test(t)) return { code: 'protocol-missing', message: "This server's protocol isn't installed on this computer.", action: 'Pick another server', retry: false, internal: false };
  // dvpnd applies the kill switch before Windows has created the tunnel adapter (UPSTREAM-GAPS #29).
  // The node's signed details don't verify (an older or misconfigured node). dvpnd checks this
  // before any deposit (failed precondition). Seen on the owner's laptop 2026-10-21, node 5CBc2eb3.
  if (/verifying (node )?metadata|metadata signature/i.test(t)) return { code: 'node-identity', message: "This server failed its identity check: its signed details don't match its listing. It may run an older version. Nothing was paid.", action: 'Pick another server', retry: false, internal: false };
  // dvpnd audits the server's account of your deposit before paying more. A server that billed more
  // than this device measured (or whose books disagree with the chain) is not paid again on that
  // deposit: the refusal protects your money. Settling closes that deposit; others still work.
  // Seen on the Mac rig 2026-10-22 (WireGuard node after "node overcharging", gap #73).
  if (/node settled exceeds the recorded sessions|node claims unpaid usage|node owed does not match|node usage exceeds local usage|node ledger disagrees|node ledger is not signed/i.test(t)) return { code: 'node-ledger', message: "This server billed more than this device measured, so the app won't pay it again from this deposit. Nothing more was paid. Pick another server; settling returns what is left of this deposit.", action: 'Pick another server', retry: false, internal: false };
  if (/node price differs from the listing/i.test(t)) return { code: 'node-price', message: "This server's price changed since you paid the deposit. Nothing more was paid. Pick another server, or settle and reconnect at the new price.", action: 'Pick another server', retry: false, internal: false };
  if (/applying (firewall|kill switch)/i.test(t)) return { code: 'kill-switch-failed', message: 'The VPN service could not turn on the kill switch for this connection, so it stopped. Try again, or turn the kill switch off in Settings.', action: 'Retry', retry: true, internal: false };
  // Hysteria2's QUIC never got an answer: on a small-MTU network (1280, gap #80) or where UDP is
  // blocked. Said before the generic tunnel copy so the user learns to switch protocol.
  if (/starting hysteria2[\s\S]*no recent network activity/i.test(t)) return { code: 'tunnel-failed', message: "Hysteria2 couldn't reach this server. The server may be down, or this network may block UDP or allow only small packets; a server with another protocol usually works. The unused deposit comes back when it closes.", action: 'Try another protocol', retry: false, internal: false };
  // dvpnd's post-connect check (Q0357): the tunnel came up but carried nothing. A path that drops large
  // packets (an MTU black hole) is clamped first; these say what is left. Before the generic tunnel copy
  // and the TLS-interception rule (the check's detail can name an x509 error).
  if (/no traffic passes through the tunnel/i.test(t)) return { code: 'tunnel-dead', message: "The tunnel came up but no traffic passes through it. The server may be misconfigured, or this network may block it. The unused deposit comes back when it closes.", action: 'Try another server or protocol', retry: true, internal: false };
  if (/starting service|tunnel not connected|handshake did not complete|not ready/i.test(t)) return { code: 'tunnel-failed', message: "The server accepted the deposit but the tunnel didn't come up. The server may be down, or your network may block this protocol (WireGuard, AmneziaWG and Hysteria2 need UDP). The unused deposit comes back when it closes.", action: 'Try another server or protocol', retry: true, internal: false };
  if (/insufficient lamports|insufficient funds for (fee|rent)|Attempt to debit an account but found no record/i.test(t)) return { code: 'device-sol', message: 'This device is out of SOL for network fees.', action: 'Top up device', retry: false, internal: false };
  // A deposit to this server is still being confirmed (or its open never landed): dvpnd blocks a second
  // deposit to the same server for up to 5 minutes so you can't pay twice (rig + clean 22.04 2026-10-22).
  if (/channel opening is pending|fetching channel [1-9A-HJ-NP-Za-km-z]{32,44}: account not found/i.test(t)) return { code: 'deposit-pending', message: 'Your deposit with this server is still being confirmed by the network. Try again in a few minutes; you will not pay twice. Or pick another server now.', action: 'Pick another server', retry: true, internal: false };
  // The RPC answered with something that is not TLS: a network in between (captive portal, proxy,
  // filtering box) intercepted it. Seen on a Test Lab Pixel 8a 2026-10-22: "tls: received record
  // with version 3 when expecting version 303" on every getLatestBlockhash. Nothing was paid.
  if (/tls: (received record|first record does not look like)|x509: certificate|certificate signed by unknown authority/i.test(t)) return { code: 'rpc-network', message: "This network intercepted the connection to the Solana network (a login page, proxy or filter). Nothing was paid. Try another network, or set your own RPC endpoint in Settings.", action: 'Retry', retry: true, internal: false };
  // The node's API refused before any deposit (test-host restart 06:51; port of the Linux app d590ee4b).
  if (/fetching node metadata[\s\S]*(connection refused|network is unreachable|no route to host|no such host|connection reset)/i.test(t)) return { code: 'node-offline', message: "This server isn't answering right now, so nothing was paid. Pick another server, or try again in a few minutes.", action: 'Pick another server', retry: false, internal: false };
  // The node was fine; the public devnet RPC stalled (the Linux app rig F5, port of Linux 379c2e96).
  if (/rpc call \w+\(\)[^:]*:[\s\S]*(deadline exceeded|timed out|timeout|connection refused|no such host)/i.test(t)) return { code: 'rpc-timeout', message: "The Solana network endpoint didn't answer in time, so nothing was paid. Try again in a minute, or add your own RPC endpoint in Settings.", action: 'Retry', retry: true, internal: false };
  if (/deadline exceeded|timed out|timeout/i.test(t)) return { code: 'timeout', message: "The server didn't answer in time.", action: 'Retry', retry: true, internal: false };
  if (/InstructionDidNotDeserialize|\b102\b/.test(t)) return { code: 'chain-encoding', message: 'The payment transaction was rejected by the network program.', action: 'Try stream payment', retry: false, internal: true };
  // A key-based endpoint (Helius etc.) that is out of credit answers 429 with "max usage reached":
  // retrying never helps, so name the fix. Seen 2026-10-21 on the laptop service's own RPC setting.
  if (/max usage reached|invalid character 'm' looking for beginning of value|credits? (?:exhausted|exceeded)/i.test(t)) return { code: 'rpc-quota', message: "The VPN service's Solana RPC endpoint has run out of credit. Set another endpoint in Settings → VPN service → RPC.", action: 'Open settings', retry: false, internal: false };
  if (/429|Too Many Requests|rate limit/i.test(t)) return { code: 'rpc-busy', message: 'The Solana network endpoint is rate-limiting requests. Wait a minute and try again, or add your own RPC endpoint in Settings.', action: 'Retry', retry: true, internal: false };
  // The node answered HTTP 500 after the deposit was paid (seen 2026-10-21: the node's own RPC
  // was out of credit). The deposit stays open for that server, so a retry reuses it.
  if (/internal: internal error|status(?: code)?:? 500\b/i.test(t)) return { code: 'node-error', message: 'The server had a problem starting your session. Your deposit with it is kept and will be used when you try again. Try again in a minute, or pick another server.', action: 'Retry', retry: true, internal: false };
  if (/unavailable|connect EPERM|ENOENT|No connection established/i.test(t)) return { code: 'daemon-unavailable', message: 'The VPN service is not running.', action: 'Open diagnostics', retry: false, internal: false };
  return { code: 'unknown', message: 'Something went wrong. Retry.', action: 'Retry', retry: true, internal: false };
}

/** `ticket_invalid` is intermittent — retry ≥3 times with backoff before showing it (docs/29 §8). */
export const TICKET_RETRY_DELAYS_MS = [1500, 3000, 6000];
/** Waits before retrying a start the RPC rate-limited (429): reuse of a deposit/ticket only. */
export const RPC_BUSY_DELAYS_MS = [2000, 5000, 10000];
// Waits before deciding a deposit carried on with after a 429 never landed (RPC nodes lag a few seconds).
// 4 + 8 + 15 s: on the public devnet RPC a 429-delayed open took longer than 12 s to show (test-host ui-sp-wireguard-2).
export const ADOPT_LAG_DELAYS_MS = [4000, 8000, 15000];

/**
 * dvpnd opens a new deposit, then reads it back. When that read is rate-limited the error names
 * the deposit, which is already open and paid (checked on devnet 2026-10-21: the open tx landed
 * one second before the 429). Returns that deposit's address, or null for any other error.
 */
/**
 * A new-deposit start that the RPC rate-limited (429) with another wording: decide from dvpnd's own
 * channel list (local, no RPC) whether a deposit to this node was opened during the attempt.
 * 'adopt' → carry on with that deposit (never pay twice); 'retry' → nothing new, safe to pay again
 * later; 'unknown' → the list could not be read, stop.
 */
export function newDepositAfter429(
  node: string,
  before: ReadonlySet<string> | null,
  after: ReadonlyArray<{ address: string; node: string; status: string }> | null,
): { action: 'adopt'; channel: string } | { action: 'retry' } | { action: 'unknown' } {
  if (!before || !after) return { action: 'unknown' };
  const fresh = after.find((c) => c.node === node && !before.has(c.address) && !/closed/i.test(c.status));
  return fresh ? { action: 'adopt', channel: fresh.address } : { action: 'retry' };
}

/** After a 429 the app may carry on with a deposit dvpnd listed as new. If the chain then says that
 *  channel does not exist, either the RPC lags (it landed) or its open never landed (nothing paid).
 *  Rig 2026-10-22: the open never landed and connect failed with "Something went wrong". */
export function adoptedChannelMissing(msg: string, channel: string | null): boolean {
  return !!channel && /account not found/i.test(msg) && msg.includes(channel);
}

export function openedChannelOn429(msg: string): string | null {
  if (!/429|Too Many Requests|rate limit/i.test(msg)) return null;
  return /fetching channel ([1-9A-HJ-NP-Za-km-z]{32,44})\b/.exec(msg)?.[1] ?? null;
}

/**
 * Kill switch × protocol on Windows (UPSTREAM-GAPS #29, measured on a clean VM 2026-10-21):
 * WireGuard fails to start and leaves the PC offline; AmneziaWG and OpenVPN connect but the
 * kill switch blocks the tunnel itself. Hysteria2 and V2Ray/Xray work. Refused before paying.
 * Returns the message to show, or null when the combination is fine.
 */
const KS_BROKEN_ON_WINDOWS: Record<string, string> = { wireguard: 'WireGuard', amneziawg: 'AmneziaWG', openvpn: 'OpenVPN' };
/** dvpnd builds from cf4c372-rc on wait for the tunnel adapter before arming the kill switch (gap #29 fix). */
export function daemonFixesKillSwitch(version: string | null | undefined): boolean {
  const m = /ddv(\d+)/.exec(String(version ?? ''));
  return !!m && Number(m[1]) >= 5;
}
/**
 * What dvpnd applies from [split] (it keeps the full tunnel otherwise: every app on the VPN,
 * nothing leaks):
 * - by app: V2Ray/Xray in whole-device mode, dvpnd cf4c372-rc+; WireGuard, AmneziaWG, OpenVPN on Windows rc+, Hysteria2 rc+;
 * - by route: those two from rc, WireGuard, AmneziaWG, OpenVPN (IPv4) and Hysteria2 from rc;
 * - with the kill switch on: Windows from rc (WFP permits the left-out traffic), else never.
 * Returns why the split is not applied, or null.
 */
export const SPLIT_SERVICES = ['v2ray', 'xray'];
const ROUTE_SPLIT_SERVICES = ['wireguard', 'amneziawg', 'openvpn', 'hysteria2'];
function ddv(version: string | null | undefined): number {
  const m = /ddv(\d+)/.exec(String(version ?? ''));
  return m ? Number(m[1]) : 0;
}
export function daemonSupportsSplit(version: string | null | undefined): boolean {
  return ddv(version) >= 11;
}
export function splitNotApplied(o: { daemonVersion?: string | null; service: string | null; killSwitch?: string; wholeDevice?: boolean; hasApps?: boolean; platform?: string }): string | null {
  const svc = (o.service ?? '').toLowerCase();
  const build = ddv(o.daemonVersion);
  // rc+ on Windows: the kill switch lets the left-out traffic through (WFP permits) while the chosen traffic still fails closed.
  if (o.killSwitch && o.killSwitch !== 'off' && (build < 13 || o.platform !== 'win32')) return 'Split tunnelling works with the kill switch off on this version. Every app uses the VPN.';
  if (SPLIT_SERVICES.includes(svc)) {
    if (build < 11) return 'Split tunnelling needs a newer VPN service. Every app uses the VPN.';
    if (o.wholeDevice === false) return 'Turn on "Whole computer" for V2Ray and Xray to use split tunnelling. Until then only apps set to use the proxy use the VPN.';
    return null;
  }
  if (ROUTE_SPLIT_SERVICES.includes(svc)) {
    // Windows: WireGuard, AmneziaWG, OpenVPN (rc+) and Hysteria2 (rc+) carry a split by app through the Xray router in front of the tunnel.
    const appsOk = o.platform === 'win32' && build >= (svc === 'hysteria2' ? 15 : 14);
    if (o.hasApps && !appsOk) return o.platform !== 'win32'
      ? 'Choosing apps works on Windows. Here split tunnelling works by address range only; every app uses the VPN.'
      : 'Choosing apps on this server needs a newer VPN service. Every app uses the VPN.';
    if (build < 12) return 'Split tunnelling needs a newer VPN service. Every app uses the VPN.';
    return null;
  }
  return 'Split tunnelling is not available for this server. Every app uses the VPN.';
}
export function killSwitchBlocksProtocol(platform: string, killSwitch: string | undefined, service: string | null, daemonVersion?: string | null): string | null {
  if (platform !== 'win32' || !killSwitch || killSwitch === 'off' || !service || daemonFixesKillSwitch(daemonVersion)) return null;
  const name = KS_BROKEN_ON_WINDOWS[service.toLowerCase()];
  if (!name) return null;
  return `The kill switch does not work with ${name} on Windows yet: it blocks the VPN itself. Turn the kill switch off in Settings, or pick a Hysteria2, V2Ray or Xray server. Nothing was paid.`;
}
