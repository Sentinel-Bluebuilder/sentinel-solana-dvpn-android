// ─── `status` — wallet, device, service, session and what the session really covers ───
// Split from commands.ts (500-line rule). Same snapshot the app shows; a live session is
// titled by core/session/coverage, measured here because the CLI runs no scheduler.
import type { Cmd } from './commands';
import { log } from '../main/logger';
import { runJobNow } from '../main/scheduler';
import { patch, snapshot } from '../main/app-state';
import { refreshWallet } from '../main/services/wallet';
import { adoptRunningSession, sessionStateUnknown } from '../main/services/connection';
import { daemonInfo } from '../main/daemon/manager';
import { clearSystemProxy, systemProxyActive } from '../main/system/proxy';
import { leftoverTunnels } from '../main/system/tunnels';
import { formatBytes } from '../shared/format';
import { tdvpn, sol } from '../core/chain/amounts';
import { MODE_STREAM } from '../core/chain/idl';
import { readSettlements } from '../main/services/settlement';
import { internetReachable } from '../core/quality/reachability';
import { getRpcUrls } from '../core/chain/rpc';

/** How the live session is paid: a plan has no channel; a deposit is per hour (stream) or per GB (from the Linux app). */
export function paymentLabel(channel: string, mode: number | null): string {
  if (!channel) return 'plan';
  if (mode === null) return 'deposit';
  return mode === MODE_STREAM ? 'per hour' : 'per GB';
}

const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

export const statusCmd: Cmd = async (_a, o) => {
  await adoptRunningSession();
  const w = await refreshWallet();
  const d = daemonInfo();
  if (snapshot().session) {
    // The system proxy may have been set by the app or an earlier CLI run for this user.
    patch({ proxyActive: systemProxyActive() });
    const r = await runJobNow('ip');
    if (r.error) log.warn('status: ip check failed', { err: r.error });
  }
  let pay = '';
  const live = snapshot().session;
  if (live) {
    let mode: number | null = null;
    if (live.channel) {
      try { mode = (await readSettlements()).find((x) => x.channel === live.channel)?.mode ?? null; } catch (err) { log.warn('status: channel read failed', { err: (err as Error).message }); }
    }
    pay = paymentLabel(live.channel, mode);
  }
  const s = snapshot();
  // Q0373: a running dvpnd that did not answer may be redialing: never "Not connected", no Restore advice.
  const unknown = !s.session && sessionStateUnknown();
  const ipLine = s.session && s.publicIp?.sid === s.session.id
    ? `IP       ${s.publicIp.ip}${s.publicIp.viaProxy ? ` through the VPN proxy; apps not using it: ${s.publicIp.directIp ?? 'unknown'}` : ''}${s.homeIp ? `  (yours when not connected: ${s.homeIp})` : ''}`
    : null;
  const lines = [
    `Wallet   ${s.owner ?? 'none'}${w ? `  ${sol(w.ownerLamports)} SOL  ${tdvpn(w.ownerTdvpn)} tDVPN  refundable ${tdvpn(w.userBalance)}` : s.owner ? '  balances unknown (the network could not be reached)' : ''}`,
    `Device   ${d.device ?? 'not set up'}${w?.grant ? `  allowance ${tdvpn(w.grant.allowance)} tDVPN  ${sol(w.deviceLamports)} SOL` : d.device ? (w ? '  no spending permission' : '  spending limit unknown (the network could not be reached)') : ''}`,
    `Daemon   ${d.reachable ? `running ${d.version}${d.networkOk === false ? '  WRONG NETWORK' : ''}` : `not reachable (${d.error ?? d.bridge})`}`,
    `Session  ${s.session ? `${s.conn.title}  node ${short(s.session.node)}  ${s.session.service}  ${pay}  down ${formatBytes(s.session.rxBytes)}  up ${formatBytes(s.session.txBytes)}  spent ${tdvpn(s.session.spent)} tDVPN` : unknown ? 'unknown: the VPN service is running but did not answer (it may be reconnecting)' : s.conn.title}`,
  ];
  if (ipLine) lines.push(ipLine);
  if (s.session && s.conn.detail) lines.push(`         ${s.conn.detail}`);
  // A tunnel with no session behind it (gaps #29, the Linux app) blocks or silently reroutes traffic.
  const leftover = s.session || unknown ? [] : await leftoverTunnels();
  if (leftover.length) lines.push(`Leftover ${leftover.join(', ')} still running with no session: run "daemon restore-network"`);
  // A system proxy we set for a session that has since ended (process killed, node gone, no app
  // running to restore it) points every proxy-aware app at a dead port: put the user's back.
  if (!s.session && !unknown && systemProxyActive()) {
    try {
      await clearSystemProxy();
      lines.push('Proxy    restored your own proxy setting (it still pointed at a session that has ended)');
    } catch (err) {
      lines.push(`Proxy    still points at an ended session and could not be restored (${(err as Error).message}): run "proxy off"`);
    }
  }
  // With no session the internet should work. The kill switch keeps the RPC open, so the wallet
  // line can read fine while every other site is blocked (dvpnd rc+ holds the block after it
  // crashed mid-session, persist mode holds it after a restart): probe an ordinary site.
  // Same check as the app's Restore network: TCP dials only, RPC hosts dropped (the kill switch
  // leaves them open), no third-party HTTP, so it runs even with third-party checks off (C15).
  const internet = s.session || unknown ? null : await internetReachable(getRpcUrls());
  if (internet === false) lines.push('Internet blocked or down. If the kill switch is still blocking (after a crash or restart), "disconnect" gives the internet back.');
  o.print(lines.join('\n'), { owner: s.owner, wallet: w, daemon: d, conn: s.conn, session: s.session, payment: pay || null, coverage: s.coverage, publicIp: s.publicIp, homeIp: s.homeIp, leftover, internet });
};
