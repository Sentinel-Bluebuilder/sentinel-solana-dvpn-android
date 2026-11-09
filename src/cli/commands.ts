// ─── CLI commands — every one calls the same services the desktop app uses ───
// Spend commands print what they will do and stop unless --yes is given (exit 2).
import fs from 'node:fs';
import os from 'node:os';
import QRCode from 'qrcode';
import { MODE_STREAM, MODE_VOUCHER } from '../core/chain/idl';
import { lanRanges } from '../core/net/lan';
import { tailLog } from '../main/logger';
import type { Args } from './args';
import { flag, str, whole, UsageError } from './args';
import { isWalletAddress } from '../core/wallet/keys';
import { plural, formatPeriod, formatBytes } from '../shared/format';
import type { Result } from '../shared/types';
import { snapshot } from '../main/app-state';
import { isAndroid } from '../main/platform/android-bridge';
import { refreshWallet, deviceSetup, deviceSetupPlan, send, revokeDeviceAccess, revokeOtherDevice, SERVICE_NOT_STARTED } from '../main/services/wallet';
import { refreshNodes, nodeViews, findNode, toggleFavourite } from '../main/services/nodes';
import { connect, disconnect, adoptRunningSession, stopOtherConnect } from '../main/services/connection';
import { clearSystemProxy } from '../main/system/proxy';
import { readSettlements, runSettlement, withdraw } from '../main/services/settlement';
import { refreshPlans, refreshSubscriptions, roster, subscribe, closeSub } from '../main/services/plans';
import { recentNodes, fundChannel, withChainStatus } from '../main/services/activity';
import { daemon, daemonInfo, registerDevice, detectDevice, deviceRecord, startServiceIfStopped } from '../main/daemon/manager';
import { DaemonError } from '../core/daemon/client';
import { getDaemonSettings } from '../main/daemon/settings';
import { getSettings } from '../main/system/settings';
import { createWallet, importWallet, logout, ownerAddress, ownerSigner } from '../main/wallet/vault';
import { discoverNode, probeNode } from '../core/nodes/discovery';
import { costPreview, priceLabel, type Basis } from '../core/pricing/cost';
import { tdvpn, sol } from '../core/chain/amounts';
import { formatCountdown } from '../core/settlement/settlement';
import { closeReasonCopy } from '../core/session/state';
import { testCmd } from './test-cmd';
import { rivalVpns } from '../main/system/tunnels';
import { daemonCmd } from './daemon-cmd';
import { statusCmd } from './status-cmd';
import { pollCmd } from './poll-cmd';
import { splitCmd } from './split-cmd';
import { splitAndroidCmd } from './split-android-cmd';

const SPLIT_HELP = 'status | apps [--search TEXT] (desktop: change it with daemon set --split-*) | show | set all|include|exclude [package…] | routes all|include|exclude [address…] (Android)';
import { historyCmd, qualityCmd, rpcCmd, settingsCmd, proxyCmd } from './info-cmd';
import { leftoverTunnels } from '../main/system/tunnels';

export interface Out { json: boolean; print(human: string, data?: unknown): void }
export class NeedsConfirm extends Error {}

export type Cmd = (a: Args, o: Out) => Promise<void>;

export function need(r: Result<unknown>): void {
  if (!r.ok) {
    const e = new Error(r.error ?? 'failed') as Error & { code?: string; action?: string | null };
    e.code = r.code;
    e.action = r.action;
    throw e;
  }
}

export function confirm(a: Args, o: Out, what: string, data?: unknown): void {
  if (flag(a, 'yes')) return;
  o.print(`${what}\nRe-run with --yes to do it.`, { needsConfirm: true, what, ...((data as object) ?? {}) });
  throw new NeedsConfirm(what);
}

const APP_VERSION = process.env.DVPN_APP_VERSION ?? 'dev';
const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const basisOf = (a: Args): Basis => {
  const b = str(a, 'basis', getSettings().defaultBasis);
  if (b !== 'per_gb' && b !== 'per_hour') throw new UsageError('--basis must be per_gb or per_hour');
  return b;
};

/** Balances, or a clear error when a wallet exists but the read failed (null means both otherwise). */
export async function walletRead(): Promise<NonNullable<Awaited<ReturnType<typeof refreshWallet>>>> {
  const w = await refreshWallet();
  if (w) return w;
  if (!ownerAddress()) throw new Error('No wallet. Run "wallet create" or "wallet import <file>".');
  throw new Error(`Could not read the balances of ${ownerAddress()} right now (network or RPC busy). Try again in a moment.`);
}

// ─── wallet ───
const wallet: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'show';
  if (sub === 'show') {
    if (!ownerAddress()) { o.print('No wallet. Run "wallet create" or "wallet import <file>".', { wallet: null }); return; }
    const w = await walletRead();
    o.print(`Address    ${w.owner}\nSOL        ${sol(w.ownerLamports)}\ntDVPN      ${tdvpn(w.ownerTdvpn)}\nRefundable ${tdvpn(w.userBalance)}\nApproved   ${tdvpn(w.delegated)} (shared by all devices)`, w);
  } else if (sub === 'create') {
    confirm(a, o, 'Create a new wallet on this computer and show its 24-word recovery phrase once.');
    const r = createWallet();
    o.print(`Created ${r.address}\nWrite these 24 words down. They are shown once:\n${r.mnemonic}`, r);
  } else if (sub === 'import') {
    const src = a._[2];
    if (!src) throw new UsageError('wallet import <keyfile.json | -> (- reads stdin)');
    const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    o.print(`Imported ${importWallet(text).address}`, { address: ownerAddress() });
  } else if (sub === 'receive') {
    const addr = ownerAddress();
    if (!addr) throw new UsageError('no wallet');
    const qr = await QRCode.toString(addr, { type: 'terminal', small: true });
    o.print(`${addr}
${qr}Devnet SOL: https://faucet.solana.com/`, { address: addr });
  } else if (sub === 'logout') {
    confirm(a, o, 'Remove the wallet key from this computer. Funds stay on chain; you need your backup to get back in.');
    logout();
    o.print('Wallet removed.', { ok: true });
  } else if (sub === 'send') {
    const to = str(a, 'to');
    if (!to) throw new UsageError('wallet send --to <address> [--tdvpn N] [--sol N] --yes');
    // Check everything that costs nothing BEFORE asking for --yes.
    if (!isWalletAddress(to)) throw new UsageError(`"${to}" is not a Solana wallet address.`);
    const amt = (k: string): number => { const v = str(a, k); const n = v === undefined ? 0 : Number(v); if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${k} must be a positive number`); return n; };
    if (amt('tdvpn') === 0 && amt('sol') === 0) throw new UsageError('Give --tdvpn N and/or --sol N.');
    const parts = [amt('tdvpn') ? `${str(a, 'tdvpn')} tDVPN` : '', amt('sol') ? `${str(a, 'sol')} SOL` : ''].filter(Boolean).join(' and ');
    confirm(a, o, `Send ${parts} to ${to} on Solana devnet.`);
    const r = await send({ to, tdvpn: str(a, 'tdvpn'), sol: str(a, 'sol'), confirmed: true });
    need(r);
    o.print(`Sent. ${r.data}`, { signature: r.data });
  } else throw new UsageError(`unknown: wallet ${sub}`);
};

// ─── device ───
const device: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'show';
  const allowance = str(a, 'allowance', getSettings().allowanceTdvpn)!;
  if (sub === 'show') {
    const w = await walletRead();
    const d = deviceRecord();
    o.print(`Device     ${d?.device ?? 'none'}\nHome       ${d?.home ?? '-'}\nAllowance  ${w?.grant ? tdvpn(w.grant.allowance) + ' tDVPN' : 'none'}\nDevice SOL ${w ? sol(w.deviceLamports) : '-'}\nReady      ${w?.ready ? 'yes' : 'no'}`, { device: d, grant: w?.grant ?? null, ready: !!w?.ready });
  } else if (sub === 'register') {
    const owner = ownerAddress();
    if (!owner) throw new UsageError('device register [device-pubkey] [--home <dir>]   (wallet required)');
    let pk = a._[2];
    if (!pk) {
      const d = await detectDevice(str(a, 'home'));
      if (!d.ok || !d.device) throw new Error(d.error ?? 'could not read the device key');
      pk = d.device;
    }
    registerDevice(pk, owner, str(a, 'home'));
    o.print(`Recorded device ${pk}`, { device: pk });
  } else if (sub === 'plan' || sub === 'setup') {
    // The service's message names the Welcome screen; a CLI user has none (the Linux app, Linux 92fce1ef).
    if (ownerAddress() && !daemonInfo().device) throw new Error(`${isAndroid() ? 'This phone' : 'This computer'} has no device key yet. Create it first with: devnet-dvpn daemon init. Then run device setup again.`);
    const p = await deviceSetupPlan(allowance);
    need(p);
    if (!p.data!.steps.length) {
      const svc = sub === 'setup' ? await startServiceIfStopped() : undefined;
      o.print(`Device already set up for that allowance.${svc === 'started' ? ' VPN service started.' : svc === 'no-right' || svc === 'failed' ? `\n${SERVICE_NOT_STARTED}` : ''}`, { steps: [], service: svc });
      return;
    }
    if (sub === 'plan') { o.print(p.data!.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), p.data); return; }
    confirm(a, o, `One transaction:\n${p.data!.steps.map((s) => `  - ${s}`).join('\n')}`, p.data);
    const r = await deviceSetup(allowance);
    need(r);
    const svc = await startServiceIfStopped();
    o.print(`Device ready. ${r.data ?? ''}${svc === 'no-right' || svc === 'failed' ? `\n${SERVICE_NOT_STARTED}` : ''}`, { signature: r.data, service: svc });
  } else if (sub === 'revoke' && str(a, 'device')) {
    // Another device of this wallet (gap #95): a computer that is gone, its key lost.
    const other = str(a, 'device')!;
    confirm(a, o, `Remove spending permission for ANOTHER device ${other}. Do this only for a computer you no longer use: it can no longer pay for VPN sessions. Then: settle run --device ${other} --yes`);
    const r = await revokeOtherDevice(other);
    need(r);
    o.print(`Removed. ${r.data}\nNext: settle run --device ${other} --yes`, { signature: r.data });
  } else if (sub === 'revoke') {
    const d = deviceRecord();
    if (!d) throw new UsageError('no device recorded');
    confirm(a, o, `Remove spending permission for device ${d.device}.`);
    const r = await revokeDeviceAccess();
    need(r);
    o.print(`Removed. ${r.data}`, { signature: r.data });
  } else throw new UsageError(`unknown: device ${sub}`);
};

// ─── nodes ───
const nodes: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'list';
  if (sub === 'list') {
    await refreshNodes({ probe: !flag(a, 'no-probe') });
    let list = nodeViews();
    if (flag(a, 'online')) list = list.filter((n) => n.probe?.ok);
    const c = str(a, 'country');
    if (c) list = list.filter((n) => n.countryCode === c.toUpperCase());
    const p = str(a, 'protocol');
    if (p) list = list.filter((n) => n.protocolNames.includes(p));
    if (str(a, 'sort') === 'price') list.sort((x, y) => Number(BigInt(x.pricePerGb) - BigInt(y.pricePerGb)));
    o.print(list.map((n) => `${n.probe?.ok ? 'up  ' : n.listingFresh ? 'down' : 'gone'}  ${n.address}  ${n.countryCode.padEnd(2)} ${priceLabel(n.pricePerGb, 'per_gb').padEnd(18)} ${priceLabel(n.pricePerHour, 'per_hour').padEnd(18)} ${n.protocolNames.join(',')}${n.probe && !n.probe.ok ? `  (${n.probe.error})` : ''}`).join('\n') || 'No nodes.', list);
  } else if (sub === 'show' || sub === 'probe') {
    const addr = a._[2];
    if (!addr) throw new UsageError(`nodes ${sub} <node>`);
    const n = await discoverNode(addr);
    if (!n) throw new Error('No such node.');
    const probe = await probeNode(n);
    o.print(`${n.address}\n  ${n.country} (${n.continent})  ${n.uri}\n  listed ${n.listed} fresh ${n.listingFresh}\n  ${priceLabel(n.pricePerGb, 'per_gb')}  ${priceLabel(n.pricePerHour, 'per_hour')}\n  protocols ${n.protocolNames.join(', ')}\n  probe ${probe.ok ? 'OK' : probe.error}${probe.latencyMs ? `  ${probe.latencyMs} ms` : ''}`, { ...n, probe });
  } else if (sub === 'fav') {
    const addr = a._[2];
    if (!addr) throw new UsageError('nodes fav <node>');
    const on = toggleFavourite(addr);
    o.print(on ? 'Added to favourites.' : 'Removed from favourites.', { favourite: on });
  } else if (sub === 'recent') {
    const r = recentNodes();
    const views = nodeViews();
    o.print(r.map((addr) => {
      const n = views.find((x) => x.address === addr);
      return n ? `${addr}  ${n.country}  ${n.protocolNames.join(', ')}` : addr;
    }).join('\n') || 'No recent servers.', r);
  } else throw new UsageError(`unknown: nodes ${sub}`);
};

// ─── cost / connect / disconnect / sessions ───
const cost: Cmd = async (a, o) => {
  const n = a._[1] ? await discoverNode(a._[1]) : null;
  if (!n) throw new UsageError('cost <node> [--basis per_gb|per_hour] [--units N]');
  const basis = basisOf(a);
  const c = costPreview(n, basis, whole(a, 'units', basis === 'per_gb' ? getSettings().defaultGb : getSettings().defaultHours, 1, 1000));
  o.print(c.available ? `Deposit ${c.escrowText} for ${c.units} ${basis === 'per_gb' ? 'GB' : 'h'}. ${c.feeText}. Unused deposit is refunded after settlement.` : `This node does not sell ${basis}.`, c);
};

const connectCmd: Cmd = async (a, o) => {
  const node = a._[1];
  if (!node) throw new UsageError('connect <node> [--basis] [--units N] [--plan <subscription>] --yes');
  // Inputs first: a bad value is a usage error before anything runs (linux edge: --units 0 --yes paid for 1 unit).
  whole(a, 'units', 1, 1, 1000);
  await adoptRunningSession();
  // Cosmos lesson D6: warn (stderr, not stdout: --json stays clean) when another VPN holds the route.
  const rivals = await rivalVpns();
  if (rivals.length) process.stderr.write(`Warning: another VPN is on (${rivals.join(', ')}). Turn it off first: two VPNs fight over the same traffic and this one may carry nothing.\n`);
  try {
    const basis = basisOf(a);
    const units = whole(a, 'units', basis === 'per_gb' ? getSettings().defaultGb : getSettings().defaultHours, 1, 1000);
    const subAddr = str(a, 'plan');
    let subscription: { provider: string; subscription: string } | undefined;
    if (subAddr) {
      const s = (await refreshSubscriptions()).find((x) => x.address === subAddr);
      if (!s) throw new Error('You do not hold that subscription.');
      subscription = { provider: s.provider, subscription: s.address };
      confirm(a, o, `Connect to ${node} using plan subscription ${subAddr} (no deposit).`);
    } else {
      const n = await discoverNode(node);
      if (!n) throw new Error('No such node.');
      const c = costPreview(n, basis, units);
      confirm(a, o, `Connect to ${node}: deposit up to ${c.escrowText} (${units} ${basis === 'per_gb' ? 'GB' : 'h'}), unused part refunded after settlement.`, c);
    }
    const r = await connect({ node, basis, units, confirmed: true, subscription, switch: flag(a, 'switch') });
    need(r);
    o.print(`Connected. Session ${r.data!.id}  ${r.data!.service}${r.data!.proxyEndpoint && !isAndroid() ? `  SOCKS ${r.data!.proxyEndpoint}` : ''}`, r.data);
    if (flag(a, 'follow')) await follow(o);
  } catch (err) {
    // With another VPN on, a failed connect is usually caused by that VPN (rival-d9: the network
    // looked unreachable because the other tunnel swallowed all traffic). Name the cause (D6).
    if (rivals.length && !(err instanceof UsageError) && !(err as Error).message.includes('Another VPN (')) throw new Error(`${(err as Error).message}\n-> Another VPN (${rivals.join(', ')}) is on and is probably blocking this: turn it off, then connect again.`);
    throw err;
  }
};

function follow(o: Out): Promise<void> {
  return new Promise((resolve) => {
    let last = '';
    const t = setInterval(() => {
      const s = snapshot();
      if (!s.session) { clearInterval(t); o.print(s.lastCloseMessage?.message ?? 'Session ended.'); resolve(); return; }
      // Usage is metered every 60 s, so print only when a line would change.
      const line = `${s.conn.title}  down ${formatBytes(s.session.rxBytes)}  up ${formatBytes(s.session.txBytes)}  spent ${tdvpn(s.session.spent)} tDVPN`;
      if (line !== last) { last = line; o.print(line, s.session); }
    }, 5000);
    process.once('SIGINT', () => { clearInterval(t); void disconnect().then(() => resolve()); });
  });
}

const disconnectCmd: Cmd = async (_a, o) => {
  await adoptRunningSession();
  if (!snapshot().session) {
    // DC1: a connect still running in another window (paying its deposit) is stopped, not ignored.
    const other = await stopOtherConnect();
    if (other.stopped) {
      await adoptRunningSession();
      if (!snapshot().session) {
        o.print(other.ended ? 'Stopped the connect that was still in progress.' : 'Asked the connect that is still in progress to stop. Run "status" in a moment to check.', { ok: true, session: null, stoppedConnect: true, ended: other.ended });
        return;
      }
      // It got up before the stop landed: disconnect it below like any session.
    }
  }
  if (!snapshot().session) {
    // The session may be gone already (service restarted, node closed it) while the system proxy we
    // set for it is still on: put it back here too (no-op when we never set it). the macOS app matrix adopt v2ray.
    await clearSystemProxy();
    // A dead session keeps the kill switch until StopSession (kss151). On (= persist) keeps it until Restore network (kdp173).
    if (getDaemonSettings().settings.killSwitch === 'persist') { o.print('No active session. The kill switch is On, so it keeps the internet blocked until you reconnect or run "daemon restore-network".', { ok: true, session: null, killSwitchReleased: false }); return; }
    let released = false;
    try { released = (await daemon().stopSession('')).killSwitchReleased; } catch (err) {
      if (!(err instanceof DaemonError) || err.kind !== 'not-found') throw err;
    }
    o.print(released ? 'No active session. Kill switch released: the internet is back.' : 'No active session.', { ok: true, session: null, killSwitchReleased: released });
    return;
  }
  const paidByDeposit = !!snapshot().session?.channel; // plan (ticket) sessions have no deposit
  const r = await disconnect();
  need(r);
  o.print(paidByDeposit ? 'Disconnected. Run "settle run --yes" to close the deposit and get the unused part back.' : 'Disconnected.', r);
};

const sessions: Cmd = async (a, o) => {
  const what = a._[0];
  if (what === 'sessions') {
    const l = await daemon().listSessions();
    o.print(l.map((s) => `${s.id}  ${s.status.padEnd(7)} ${short(s.node)}  ${s.service}  spent ${tdvpn(s.spent)}${s.error ? `  ${closeReasonCopy(s.error).message}` : ''}`).join('\n') || 'No sessions.', l);
  } else if (what === 'channels' && a._[1] === 'fund') {
    const ch = a._[2];
    const amt = str(a, 'tdvpn');
    if (!ch || !amt) throw new UsageError('channels fund <channel> --tdvpn N --yes');
    confirm(a, o, `Add ${amt} tDVPN to deposit ${ch}. Unused deposit is refunded after settlement.`);
    const r = await fundChannel(ch, amt);
    need(r);
    o.print(`Topped up. ${r.data}`, { signature: r.data });
  } else if (what === 'channels') {
    const l = await withChainStatus(await daemon().listChannels());
    // Chain modes: voucher = per-GB, stream = per-hour. Name the node so a person can tell channels apart.
    const basis = (m: number): string => (Number(m) === MODE_VOUCHER ? 'per-GB  ' : Number(m) === MODE_STREAM ? 'per-hour' : `mode ${m}  `);
    o.print(l.map((c) => `${c.address}  ${c.status.padEnd(7)} ${basis(c.mode)}  node ${c.node}  deposit ${tdvpn(c.escrow)}  used ${tdvpn(c.cumulative)}`).join('\n') || 'No channels.', l);
  } else {
    const l = await daemon().listTickets();
    o.print(l.map((t) => `${t.hash.slice(0, 12)}  sub ${short(t.subscription)}  node ${short(t.node)}`).join('\n') || 'No tickets.', l);
  }
};

// ─── plans ───
const plans: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'list';
  if (sub === 'list') {
    const l = await refreshPlans();
    o.print(l.map((p) => `${p.address}  ${tdvpn(p.price)} tDVPN / ${formatPeriod(p.durationSeconds)}  ${p.dataCapGb ? `${p.dataCapGb} GB` : 'no data cap'}  ${(p.maxConnections ? plural(p.maxConnections, 'server') : 'any number of servers')}${p.providerListed ? '' : '  (provider inactive)'}${p.providerAnswering === false ? '  (provider offline)' : ''}`).join('\n') || 'No plans.', l);
  } else if (sub === 'roster') {
    if (!a._[2]) throw new UsageError('plans roster <plan>');
    const plan = (await refreshPlans()).find((p) => p.address === a._[2]);
    if (!plan) throw new Error(`No plan ${a._[2]} on devnet. Run "plans list" to see the plans.`);
    const r = await roster(plan.provider, plan.address);
    // Servers this wallet's subscriptions to the plan already hold access (a ticket) on.
    const subs = (await refreshSubscriptions()).filter((x) => x.plan === plan.address && x.active).map((x) => x.address);
    let held: string[] = [];
    try {
      const now = Math.floor(Date.now() / 1000);
      held = (await daemon().listTickets()).filter((t) => subs.includes(t.subscription) && Number(t.expiresAt) > now).map((t) => t.node);
    } catch (err) {
      console.warn(`[cli] tickets unavailable: ${(err as Error).message}`);
    }
    const lines = r.map((x) => `${x.node}  ${x.live ? 'live' : 'down'}${held.includes(x.node) ? '  your access' : ''}`);
    if (plan.maxConnections && lines.length) lines.push(`Access on up to ${plural(plan.maxConnections, 'server')}; in use: ${new Set(held).size}.`);
    o.print(lines.join('\n') || 'Empty roster.', { roster: r, held, maxConnections: plan.maxConnections });
  } else if (sub === 'subscribe') {
    const plan = (await refreshPlans()).find((p) => p.address === a._[2]);
    if (!plan) throw new UsageError('plans subscribe <plan> --yes');
    confirm(a, o, `Subscribe for ${tdvpn(plan.price)} tDVPN, paid now. Cancelling later refunds nothing.`, plan);
    const r = await subscribe({ plan: plan.address, confirmed: true });
    need(r);
    o.print(`Subscribed. ${r.data!.subscription}  ${r.data!.signature}`, r.data);
  } else if (sub === 'subscriptions') {
    const l = await refreshSubscriptions();
    o.print(l.map((s) => `${s.address}  plan ${short(s.plan)}  ${s.active ? `expires in ${formatCountdown(s.expiresAt - Date.now() / 1000)}` : 'expired'}`).join('\n') || 'No subscriptions.', l);
  } else if (sub === 'close') {
    const id = a._[2];
    if (!id) throw new UsageError('plans close <subscription> --yes');
    confirm(a, o, `Close subscription ${id}. Only the account rent comes back; the price is not refunded.`);
    const r = await closeSub(id);
    need(r);
    o.print(`Closed. ${r.data}`, { signature: r.data });
  } else throw new UsageError(`unknown: plans ${sub}`);
};

// ─── settle ───
const settle: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'list';
  // --device <address>: another device of this wallet whose permission is removed (gap #95).
  const other = str(a, 'device');
  if (sub === 'list') {
    const l = await readSettlements(other);
    o.print(l.map((s) => `${s.channel}  ${s.status.padEnd(7)} refundable ${tdvpn(s.refundable)}${s.readyAt ? `  ready in ${formatCountdown(s.readyAt - Date.now() / 1000)}` : ''}`).join('\n') || 'Nothing to settle.', l);
  } else if (sub === 'run') {
    const l = (await readSettlements(other)).filter((s) => s.status === 'open' || s.status === 'ready');
    const only = str(a, 'channel') ? [str(a, 'channel')!] : undefined;
    confirm(a, o, `Settle ${only ? 1 : l.length} deposit(s)${other ? ` of device ${other}` : ''} now and withdraw refunds to your wallet.`, { pending: l });
    const r = await runSettlement(only, other);
    need(r);
    o.print(r.data!.length ? `Done: ${r.data!.join(', ')}` : 'Nothing was due.', { signatures: r.data });
  } else if (sub === 'withdraw') {
    confirm(a, o, 'Move your refundable balance back to your wallet.');
    const r = await withdraw();
    // Nothing to withdraw is a normal answer, not a failure: scripts can run this any time.
    if (!r.ok && r.code === 'nothing') { o.print('Nothing to withdraw: your refundable balance is 0.', { signature: null }); return; }
    need(r);
    o.print(`Withdrawn. ${r.data}`, { signature: r.data });
  } else throw new UsageError(`unknown: settle ${sub}`);
};

// ─── version / logs ───
const version: Cmd = async (_a, o) => {
  const v = { app: process.env.DVPN_APP_VERSION ?? APP_VERSION, network: 'devnet', platform: process.platform, node: process.version, lan: lanRanges(os.networkInterfaces()) };
  o.print(`devnet-dvpn ${v.app}  network ${v.network}  ${v.platform}\nlocal network ${v.lan.join(', ') || 'none found'}`, v);
};

const logs: Cmd = async (a, o) => {
  const text = tailLog(whole(a, 'lines', 100, 1, 100000));
  o.print(text || '(log is empty)', { log: text });
};

export const COMMANDS: Record<string, { run: Cmd; help: string; needsDaemon?: boolean }> = {
  version: { run: version, help: 'app version and network' },
  logs: { run: logs, help: '[--lines N] app log (secrets redacted)' },
  status: { run: statusCmd, help: 'wallet, device, daemon and session at a glance', needsDaemon: true },
  wallet: { run: wallet, help: 'show | receive | create | import <file|-> | send --to A [--tdvpn N] [--sol N] | logout' },
  device: { run: device, help: 'show | plan [--allowance N] | setup [--allowance N] | register [pubkey] (reads it from the service home if omitted) | revoke' },
  daemon: { run: daemonCmd, help: 'version | doctor | dns-check [--dns handshake|cloudflare|ip,ip] | drivers | repair-drivers | init | install | settings | set [--kill-switch off|on|persist] [--dns handshake|cloudflare|ip,ip] [--allow-lan true] [--basis] [--escrow tDVPN] [--prepay-mb N] [--prepay-minutes N] [--rpc URL] [--rpc-ws URL] | restore-network', needsDaemon: true },
  nodes: { run: nodes, help: 'list [--online] [--country DE] [--protocol wireguard] [--sort price] [--no-probe] | show <node> | fav <node> | recent' },
  cost: { run: cost, help: '<node> [--basis per_gb|per_hour] [--units N]' },
  connect: { run: connectCmd, help: '<node> [--basis] [--units N] [--plan <subscription>] [--switch] [--follow]', needsDaemon: true },
  disconnect: { run: disconnectCmd, help: 'stop the session (deposit stays open until settled)', needsDaemon: true },
  sessions: { run: sessions, help: 'daemon sessions', needsDaemon: true },
  channels: { run: sessions, help: 'daemon channels | fund <channel> --tdvpn N', needsDaemon: true },
  tickets: { run: sessions, help: 'daemon plan tickets', needsDaemon: true },
  plans: { run: plans, help: 'list | roster <plan> | subscribe <plan> | subscriptions | close <subscription>', needsDaemon: true },
  settle: { run: settle, help: 'list | run [--channel C] | withdraw', needsDaemon: true },
  history: { run: historyCmd, help: 'list | summary | export [--out file.csv]' },
  // Daemon is optional here: with a proxy session, `ip` also measures the VPN exit.
  quality: { run: qualityCmd, help: 'ip | speed (third-party services)', needsDaemon: true },
  rpc: { run: rpcCmd, help: 'state | set <url> [url...]' },
  settings: { run: settingsCmd, help: 'get | set key=value ... | reset --yes (favourites and RPC endpoints kept)' },
  proxy: { run: proxyCmd, help: 'status | on (needs a V2Ray/Xray session) | off | browser [--browser edge|chrome] [--url U]', needsDaemon: true },
  // Android chooses apps and addresses in the VPN service (split-android-cmd); desktop through dvpnd.
  // One help text for both: the desktop forms (status, daemon set --split-*) and the Android ones.
  split: isAndroid()
    ? { run: splitAndroidCmd, help: SPLIT_HELP }
    : { run: splitCmd, help: SPLIT_HELP, needsDaemon: true },
  poll: { run: pollCmd, help: 'show | set <job>=<seconds> … | reset [job…] | run [job…] | watch [--seconds N] [--hidden]' },
  test: { run: testCmd, help: 'plan <node…>|--online | run <node…>|--online [--max-spend N] | stop | history | show [run-id] [--compare] | export [run-id] [--out f]', needsDaemon: true },
};
