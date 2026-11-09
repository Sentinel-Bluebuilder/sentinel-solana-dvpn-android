// ─── CLI: history, quality, rpc, settings, proxy (split out of commands.ts, 500-line rule) ───
import fs from 'node:fs';
import { redactUrls } from '../main/logger';
import { str, UsageError } from './args';
import { formatBytes } from '../shared/format';
import { DEFAULT_SETTINGS } from '../shared/types';
import { snapshot } from '../main/app-state';
import { adoptRunningSession } from '../main/services/connection';
import { listHistory, historyCsv } from '../main/services/history';
import { spendSummary } from '../main/services/activity';
import { getSettings, resetSettings, RESET_KEYS, updateSettings } from '../main/system/settings';
import { tdvpn } from '../core/chain/amounts';
import { getRpcState, isValidRpcUrl } from '../core/chain/rpc';
import { publicIp, speedTest } from '../core/quality/quality';
import { setSystemProxy, clearSystemProxy, systemProxyActive } from '../main/system/proxy';
import { launchBrowser, BROWSERS, type BrowserName } from '../main/system/browser';
import { confirm, type Cmd } from './commands';
import { isAndroid } from '../main/platform/android-bridge';

const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

// ─── history / quality / rpc / settings ───
export const historyCmd: Cmd = async (a, o) => {
  if (a._[1] === 'summary') {
    const s = spendSummary();
    o.print([
      `Sessions   ${s.sessions}`,
      `Spent      ${tdvpn(s.spent)} tDVPN (last 30 days ${tdvpn(s.last30Spent)})`,
      `Data       ${formatBytes(s.bytes)}`,
      ...s.byNode.map((r) => `  ${short(r.node)} ${r.country.padEnd(14)} ${String(r.sessions).padStart(3)} sessions  ${tdvpn(r.spent)} tDVPN`),
    ].join('\n'), s);
    return;
  }
  if ((a._[1] ?? 'list') === 'export') {
    const csv = historyCsv();
    const file = str(a, 'out');
    if (file) { fs.writeFileSync(file, csv, 'utf8'); o.print(`Wrote ${file}`, { file }); } else o.print(csv.trimEnd(), { csv });
    return;
  }
  const l = listHistory();
  o.print(l.map((h) => `${new Date(h.startedAt).toISOString()}  ${short(h.node)}  ${h.service}  down ${formatBytes(h.rxBytes)}  spent ${tdvpn(h.spent)} tDVPN  ${h.closeReason ?? (h.endedAt ? '' : 'active')}`).join('\n') || 'No history.', l);
};

export const qualityCmd: Cmd = async (a, o) => {
  if (!getSettings().thirdPartyChecks) throw new Error('Third-party checks are turned off in settings.');
  if ((a._[1] ?? 'ip') === 'speed') {
    const r = await speedTest();
    o.print('error' in r ? r.error : `${r.mbps} Mbps (${r.source})`, r);
  } else {
    const r = await publicIp();
    // Proxy session: also show the exit IP that apps using the SOCKS endpoint get.
    await adoptRunningSession(); // logs and returns when no daemon is reachable
    // Android: the check above already runs through the tunnel (probe socket) and there is no
    // SOCKS endpoint for other apps (the VPN covers them), so no second line.
    const socks = isAndroid() ? undefined : snapshot().session?.proxyEndpoint;
    const v = socks ? await publicIp(6000, socks) : null;
    const line = 'error' in r ? r.error : `${r.ip} (${r.source})`;
    const vpn = v ? `\nVPN IP via SOCKS ${socks}: ${'error' in v ? v.error : `${v.ip} (${v.source})`}` : '';
    o.print(`${line}${vpn}`, { direct: r, viaSocks: v });
  }
};

export const rpcCmd: Cmd = async (a, o) => {
  if (a._[1] === 'set') {
    const urls = a._.slice(2);
    if (!urls.length) throw new UsageError('rpc set <url> [url...]');
    const bad = urls.filter((u) => !isValidRpcUrl(u));
    if (bad.length) throw new Error(`Not accepted (https only; http only for 127.0.0.1): ${bad.map(redactUrls).join(', ')}`);
    const s = updateSettings({ rpcUrls: urls });
    o.print(`RPC pool: ${s.rpcUrls.join(', ')}`, s.rpcUrls);
    return;
  }
  const s = await getRpcState();
  const head = s.slot == null
    ? `No RPC endpoint is answering (tried ${s.serving}). Check your internet connection, or add another endpoint: rpc set <url>.`
    : `Serving ${s.serving}  slot ${s.slot}  ${s.latencyMs ?? '?'} ms`;
  o.print(`${head}${s.publicOnly ? '\nWarning: only the public devnet RPC is configured; it rate-limits real use.' : ''}`, s);
};

export const settingsCmd: Cmd = async (a, o) => {
  if (a._[1] === 'set') {
    const patch: Record<string, unknown> = {};
    for (const kv of a._.slice(2)) {
      const eq = kv.indexOf('=');
      if (eq < 1) throw new UsageError('settings set key=value ...');
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (!(k in DEFAULT_SETTINGS)) throw new UsageError(`unknown setting "${k}". Known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
      patch[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^\d+$/.test(v) && k !== 'allowanceTdvpn' ? Number(v) : v;
    }
    const next = updateSettings(patch);
    // The allow-list drops invalid values without a word; say which ones did not take.
    const shown = (k: string): string => JSON.stringify(next[k as keyof typeof next]);
    const rejected = Object.keys(patch).filter((k) => shown(k) !== JSON.stringify(patch[k]));
    if (rejected.length) throw new Error(`The value for ${rejected.join(', ')} is not allowed, so it was left unchanged.`);
    o.print(Object.keys(patch).map((k) => `${k} = ${shown(k)}`).join('\n'), next);
    return;
  }
  if (a._[1] === 'reset') {
    confirm(a, o, `Put the app settings back to their defaults (favourites and RPC endpoints are kept):\n${RESET_KEYS.join(', ')}`);
    const next = resetSettings();
    o.print('App settings restored to defaults (favourites and RPC endpoints kept).', next);
    return;
  }
  if (a._[1] && a._[1] !== 'get') throw new UsageError(`unknown: settings ${a._[1]}`);
  const s = getSettings();
  o.print(Object.entries(s).map(([k, v]) => `${k.padEnd(18)} ${JSON.stringify(v)}`).join('\n'), s);
};

// ─── proxy (F16a) ───
// Only a live V2Ray/Xray session has a SOCKS endpoint. Pointing Windows at a proxy
// nobody serves would cut this computer off, so `on` refuses without one.
export const proxyCmd: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'status';
  if (sub === 'status') {
    await adoptRunningSession();
    const ep = snapshot().session?.proxyEndpoint ?? null;
    const active = systemProxyActive();
    const socks = ep
      ? `SOCKS proxy: ${ep} (point an app at it to send only that app through the VPN)`
      : 'SOCKS proxy: none (only a V2Ray or Xray session has one)';
    o.print(`${socks}\nSystem proxy: ${active ? 'set by this app' : 'not set by this app'}`, { endpoint: ep, active });
    return;
  }
  if (sub === 'off') { await clearSystemProxy(); o.print('System proxy restored.', { active: false }); return; }
  if (sub === 'browser') {
    const b = str(a, 'browser');
    if (b !== undefined && !BROWSERS.includes(b as BrowserName)) throw new UsageError('--browser must be edge or chrome');
    await adoptRunningSession();
    const sep = snapshot().session?.proxyEndpoint;
    if (!sep) throw new Error('The current session has no SOCKS endpoint (only V2Ray/Xray sessions do). Nothing was opened.');
    const r = launchBrowser(sep, b as BrowserName | undefined, str(a, 'url') ?? undefined);
    o.print(`Opened ${r.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} through SOCKS ${r.endpoint} in its own profile. Your other browser windows do not use the VPN.`, r);
    return;
  }
  if (sub !== 'on') throw new UsageError(`unknown: proxy ${sub}`);
  await adoptRunningSession();
  const ep = snapshot().session?.proxyEndpoint;
  if (!ep) throw new Error('The current session has no SOCKS endpoint (only V2Ray/Xray sessions do). Nothing was changed.');
  confirm(a, o, `Route this Windows user's apps through SOCKS ${ep} until disconnect.`);
  await setSystemProxy(ep);
  o.print(`System proxy set to ${ep}.`, { active: true, endpoint: ep });
};
