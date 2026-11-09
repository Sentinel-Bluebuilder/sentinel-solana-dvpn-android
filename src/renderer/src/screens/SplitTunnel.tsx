// ─── Split tunnelling page (owner 2026-10-22: "see apps and be able to choose", research-led) ───
// Standards: docs/UI-STANDARDS-RESEARCH.md § Split tunnelling (Proton include/exclude, Mullvad app
// list + "Find another app", Microsoft: checkboxes when an Apply step is needed). Engine contract:
// docs/SPLIT-TUNNEL-CONTRACT.md. What dvpnd really applies comes from splitNotApplied() (engine-owned);
// the live picture comes from the measured coverage, never from the setting alone.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, useApp } from '../lib/store';
import { Banner, Copy, Flag, PageHeader, Section, Switch } from '../components/ui';
import { ProtocolMark, ProtocolTag } from '../components/ProtocolMark';
import { useDaemonSettings } from '../lib/use-daemon-settings';
import { daemonSupportsSplit, splitNotApplied } from '../../../core/session/state';
import { validateSplit, type SplitMode, type SplitSettings } from '../../../core/daemon/config';
import { filterApps, fileName, normalizeRoute, sameNameApps, type AppEntry } from '../../../core/split/apps';
import { laneModel, type LaneItem } from '../../../core/split/lanes';
import { PROTOCOLS } from '../../../shared/protocols';
import type { AppSettings, AppSnapshot } from '../../../shared/types';
import { onAndroid } from '../lib/platform';
import { AndroidSplit } from './SplitTunnelAndroid';

type PickerApp = AppEntry & { icon: string | null };
const PLATFORM = /Windows/i.test(navigator.userAgent) ? 'win32' : 'other';
const OFF: SplitSettings = { mode: 'off', apps: [], routes: [] };

const MODES: Array<{ id: SplitMode; name: string; copy: string }> = [
  { id: 'off', name: 'Every app uses the VPN', copy: 'Split tunnelling off. Nothing leaves outside the VPN.' },
  { id: 'include', name: 'Only the apps I choose', copy: 'Chosen apps and addresses use the VPN. Everything else uses your normal connection.' },
  { id: 'exclude', name: 'Every app except the ones I choose', copy: 'Everything uses the VPN except the apps and addresses you leave out.' },
];

// Android has its own page (the VPN service applies these there, not dvpnd).
export function SplitTunnel({ snap }: { snap: AppSnapshot }) {
  return onAndroid() ? <AndroidSplit snap={snap} /> : <DesktopSplitTunnel snap={snap} />;
}

function DesktopSplitTunnel({ snap }: { snap: AppSnapshot }) {
  const { settings, setSettings, nodes } = useApp();
  const { daemon, draft, setDraft, dirty, applying, apply, reset } = useDaemonSettings();
  const [apps, setApps] = useState<PickerApp[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [route, setRoute] = useState('');
  const [routeError, setRouteError] = useState<string | null>(null);

  const split: SplitSettings = draft.split ?? OFF;
  const saved: SplitSettings = daemon?.settings.split ?? OFF;
  const setSplit = (next: Partial<SplitSettings>): void => setDraft({ ...draft, split: { ...split, ...next } });

  const loadApps = async (): Promise<void> => {
    try {
      const v = await call<{ supported: boolean; apps: PickerApp[]; error: string | null }>(window.api.IPC.APPS_LIST, { chosen: split.apps });
      setApps(v.apps);
      setAppsError(v.supported ? v.error : 'Choosing apps from a list works on Windows only.');
    } catch (err) {
      console.warn('app list failed', err);
      setApps([]);
      setAppsError('The app list could not be read. You can still browse for an app.');
    }
  };
  useEffect(() => { if (split.mode !== 'off' && apps === null) void loadApps(); }, [split.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = snap.session;
  const node = s ? nodes.find((n) => n.address === s.node) : undefined;
  const ip = snap.publicIp && s && snap.publicIp.sid === s.id ? snap.publicIp : null;
  // The app's own IP check follows the split too: in "only chosen apps" the app is not chosen, so
  // it measures the user's own IP. The VPN lane then shows the server's address instead.
  const vpnIp = snap.coverage === 'split-include' ? (ip?.nodeIp ?? null) : (ip?.ip ?? null);
  const caps = { daemonVersion: snap.daemon.version, killSwitch: draft.killSwitch, wholeDevice: draft.wholeDevice, hasApps: split.apps.length > 0, platform: PLATFORM };
  const liveReason = s ? splitNotApplied({ ...caps, service: s.service, killSwitch: daemon?.settings.killSwitch, wholeDevice: daemon?.settings.wholeDevice, hasApps: saved.apps.length > 0 }) : null;
  const nameOf = (p: string): string => apps?.find((a) => a.path === p)?.name ?? fileName(p).replace(/\.exe$/i, '');
  const lanes = laneModel({ split: s ? saved : split, liveService: s?.service ?? null, coverage: snap.coverage, notApplied: liveReason, appName: nameOf });
  const iconOf = (p?: string): string | null => (p ? apps?.find((a) => a.path === p)?.icon ?? null : null);

  const shown = useMemo(() => {
    const all = apps ?? [];
    // Chosen apps first, then running, then A–Z (mergeApps already sorts running first).
    return filterApps(all, q).sort((a, b) => Number(split.apps.includes(b.path)) - Number(split.apps.includes(a.path)));
  }, [apps, q, split.apps]);

  let invalid: string | null = null;
  try { validateSplit(split); } catch (err) { invalid = (err as Error).message; }

  const toggleApp = (path: string): void => setSplit({ apps: split.apps.includes(path) ? split.apps.filter((x) => x !== path) : [...split.apps, path] });
  const browse = async (): Promise<void> => {
    try {
      const p = await call<string>(window.api.IPC.APPS_PICK);
      if (!split.apps.includes(p)) setSplit({ apps: [...split.apps, p] });
      if (apps && !apps.some((a) => a.path === p)) setApps([{ path: p, name: fileName(p).replace(/\.exe$/i, ''), running: false, source: 'picked', icon: null }, ...apps]);
    } catch (err) { console.warn('pick app cancelled or failed', err); }
  };
  const addRoute = (): void => {
    const r = normalizeRoute(route);
    if (!r) { setRouteError('Enter an IP address or a range like 192.168.0.0/16 or 2001:db8::/32. Names like example.com don\'t work: sites behind a CDN change addresses.'); return; }
    if (!split.routes.includes(r)) setSplit({ routes: [...split.routes, r] });
    setRoute(''); setRouteError(null);
  };
  const setApp = async (patch: Partial<AppSettings>): Promise<void> => { setSettings(await call<AppSettings>(window.api.IPC.SETTINGS_SET, patch)); };

  if (!settings) return null;
  return (
    <div>
      <PageHeader title="Split tunnelling" subtitle="Choose which apps and addresses use the VPN, and which use your normal connection." />

      {snap.daemon.version && !daemonSupportsSplit(snap.daemon.version) && (
        <Banner kind="warn">Your VPN service ({snap.daemon.version}) is older than split tunnelling. You can set your choices now; they take effect after the app update installs the new service.</Banner>
      )}

      {/* Wide windows: choices left, live picture + what each server type does right. */}
      <div className="grid gap-x-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="xl:order-2">
      {/* ── Live picture ── */}
      <Section title={s ? 'Right now' : 'When you connect'}>
      <div className="card" data-split-live={s ? 'live' : 'plan'}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-4">
          <Lane id="vpn" title="Through the VPN" items={lanes.vpn} iconOf={iconOf} tone="ok"
            end={s ? <span className="flex items-center gap-2">{node && <Flag code={node.countryCode} />}<ProtocolTag protocol={s.service} />{vpnIp ?? 'checking…'}</span> : <span className="font-sans text-fg-dim">a server you pick</span>} />
          <div className="flex flex-col items-center justify-center" aria-hidden>
            <span className="h-full w-px bg-line" />
          </div>
          <Lane id="direct" title="Normal connection" items={lanes.direct} iconOf={iconOf} tone="muted"
            // homeIp, not publicIp.directIp: the app's own IP check rides the VPN, so its "direct" IP is the VPN's (VM 2026-10-22).
            end={<span>{snap.homeIp ?? 'your own IP'}</span>} />
        </div>
        {lanes.note && <p className="mt-3 text-meta text-warn">{lanes.note}</p>}
        {s && !lanes.note && saved.mode !== 'off' && <p className="mt-3 text-meta text-fg-muted">Measured: sites reached through the VPN see {vpnIp ?? '…'}. Apps on your normal connection show your own IP{snap.homeIp ? ` (${snap.homeIp}, measured before you connected)` : ''}.</p>}
      </div>
      </Section>
      </div>

      <div className="xl:order-1 xl:row-span-3">
      {/* ── Mode ── */}
      <Section title="Which apps use the VPN">
      <div className="card overflow-hidden p-0" role="radiogroup" aria-label="Split tunnelling mode">
        {MODES.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-start gap-3 border-b border-line px-4 py-3 last:border-0 hover:bg-bg-hover" data-split-mode={m.id}>
            <input type="radio" name="split-mode" className="mt-1" checked={split.mode === m.id} onChange={() => setSplit({ mode: m.id })} />
            <span><span className="text-sm font-medium">{m.name}</span><span className="block text-meta text-fg-muted">{m.copy}</span></span>
          </label>
        ))}
      </div>
      </Section>

      {split.mode !== 'off' && (
        <>
          {/* ── Apps ── */}
          <Section title={<>{split.mode === 'include' ? 'Apps that use the VPN' : 'Apps that skip the VPN'} <span className="num ml-1 text-meta text-fg-muted">{split.apps.length} chosen</span></>}>
          {split.mode === 'exclude' && <Banner kind="warn">Apps you leave out use your normal connection and show your real IP address.</Banner>}
          <div className="card mb-2 overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b border-line p-3">
              <input className="input flex-1" placeholder="Search apps" aria-label="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn-ghost" onClick={() => void loadApps()}>Refresh</button>
            </div>
            <div className="max-h-80 overflow-y-auto" data-app-list>
              {apps === null ? <p className="empty-line">Reading your apps…</p> : shown.length === 0 ? <p className="empty-line">{q ? 'No app matches.' : 'No apps found.'}</p> : shown.map((a) => {
                const on = split.apps.includes(a.path);
                const twins = on ? sameNameApps(apps, a.path).length : 0;
                const restart = a.running && on !== saved.apps.includes(a.path);
                return (
                  <label key={a.path} className="flex min-h-14 cursor-pointer items-center gap-3 border-b border-line px-4 py-2 last:border-0 hover:bg-bg-hover" data-app={a.path}>
                    <input type="checkbox" checked={on} onChange={() => toggleApp(a.path)} aria-label={a.name} />
                    {a.icon ? <img src={a.icon} alt="" className="h-6 w-6 shrink-0" /> : <span className="h-6 w-6 shrink-0 rounded bg-bg-hover" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{a.name}</span>
                      <span className="mono block truncate text-fg-muted" title={a.path}>{a.path}</span>
                      {twins > 0 && <span className="block text-meta text-fg-muted">Programs with the same name ({fileName(a.path)}) are included too.</span>}
                    </span>
                    {restart ? <span className="pill text-warn">Running · restart it to apply</span> : a.running ? <span className="pill">Running</span> : null}
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-line bg-bg-raised/40 px-4 py-3">
              <span className="text-meta text-fg-muted">{appsError ?? 'Microsoft Store apps can\u2019t be chosen.'}</span>
              <button className="btn-ghost shrink-0" onClick={() => void browse()}>Browse for an app…</button>
            </div>
          </div>
          <p className="text-meta text-fg-muted">Apps are matched by their full path and their program name, so programs with the same file name are matched too.</p>
          </Section>

          {/* ── Addresses ── */}
          <Section title={split.mode === 'include' ? 'Addresses that use the VPN' : 'Addresses that skip the VPN'}>
          <div className="card">
            <p className="mb-3 text-meta text-fg-muted">Any app reaching these addresses follows this rule. Enter an IP address or a range (IPv4 or IPv6), not a site name.</p>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addRoute(); }}>
              <input className="input flex-1 mono" placeholder="192.168.0.0/16" aria-label="Address or range" value={route} onChange={(e) => { setRoute(e.target.value); setRouteError(null); }} />
              <button type="submit" className="btn-ghost">Add</button>
            </form>
            {routeError && <p className="mt-2 text-meta text-bad" role="alert">{routeError}</p>}
            {split.routes.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2" data-route-list>
                {split.routes.map((r) => (
                  <li key={r} className="chip mono">{r}<button className="ml-2 text-fg-muted hover:text-bad" aria-label={`Remove ${r}`} onClick={() => setSplit({ routes: split.routes.filter((x) => x !== r) })}>×</button></li>
                ))}
              </ul>
            )}
          </div>
          </Section>
        </>
      )}

      {/* ── V2Ray / Xray whole computer (engine binding: draft.wholeDevice, ca28be7) ── */}
      <Section title="V2Ray and Xray: whole computer">
      <div className="card">
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span>
            <span className="text-sm font-medium">Whole computer</span>
            <span className="block text-meta text-fg-muted">On: V2Ray and Xray carry every app, like WireGuard, and your app choices above apply. Off: only browsers (with the Windows proxy) and apps you point at the VPN proxy use it.</span>
          </span>
          <Switch label="Whole computer" data-whole-device checked={draft.wholeDevice !== false} onChange={(on) => setDraft({ ...draft, wholeDevice: on })} />
        </label>
      </div>
      </Section>

      {/* ── Proxy (advanced, V2Ray/Xray sessions) ── */}
      <details className="card mb-6 p-0">
        <summary className="disclosure flex h-12 cursor-pointer items-center px-4 text-sm font-medium hover:bg-bg-hover">Advanced: V2Ray and Xray proxy</summary>
        <div className="space-y-4 border-t border-line p-4 text-sm">
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span><span className="font-medium">Set the Windows proxy when I connect</span><span className="block text-meta text-fg-muted">Browsers use the VPN even when "Whole computer" is off. Your own proxy settings come back when you disconnect.</span></span>
            <Switch label="Set the Windows proxy when I connect" data-proxy-on-connect checked={settings.proxyOnConnect} onChange={(on) => void setApp({ proxyOnConnect: on })} />
          </label>
          {s?.proxyEndpoint ? (
            <>
              <label className="flex cursor-pointer items-center justify-between gap-4">
                <span>Send apps through the VPN now (Windows proxy)</span>
                <Switch label="Send apps through the VPN now (Windows proxy)" checked={snap.proxyActive} onChange={async (on) => { try { await call(window.api.IPC.PROXY_SET, { on }); } catch (err) { console.warn('proxy toggle failed', err); } }} />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-ghost" onClick={async () => { try { await call(window.api.IPC.PROXY_BROWSER, {}); } catch (err) { console.warn('open browser failed', err); } }}>Open browser through VPN</button>
                <span className="text-meta text-fg-muted">A separate Edge or Chrome window that uses only the VPN.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-meta text-fg-muted">Any other app: SOCKS5</span>
                <span className="mono rounded bg-bg-input px-2 py-1">socks5://{s.proxyEndpoint}</span>
                <Copy text={`socks5://${s.proxyEndpoint}`} />
              </div>
            </>
          ) : <p className="text-meta text-fg-muted">Connect to a V2Ray or Xray server to use the proxy controls.</p>}
        </div>
      </details>
      </div>

      <div className="xl:order-3">
      {/* ── Per protocol ── */}
      <Section title="What each server type does with your choices">
      <div className="card overflow-hidden p-0" data-split-support>
        {PROTOCOLS.map((p) => {
          const reason = split.mode === 'off' ? null : splitNotApplied({ ...caps, service: p });
          return (
            <div key={p} className="flex min-h-12 items-center justify-between gap-4 border-b border-line px-4 py-2 text-sm last:border-0" data-split-protocol={p} data-split-ok={reason ? 'no' : 'yes'}>
              <ProtocolTag protocol={p} />
              <span className={`text-right text-meta ${reason ? 'text-fg-muted' : 'text-ok'}`}>{split.mode === 'off' ? 'Every app uses the VPN' : reason ?? 'Applied'}</span>
            </div>
          );
        })}
        {draft.killSwitch && draft.killSwitch !== 'off' && <p className="px-4 py-3 text-meta text-fg-muted">Kill switch is on: if the VPN drops, traffic you chose for the VPN is blocked; what you left out keeps your normal connection.</p>}
      </div>
      </Section>

      <Section title="Command line">
      <div className="card mono leading-6">
        <div>devnet-dvpn split status</div>
        <div>devnet-dvpn split apps [--search firefox]</div>
        <div>devnet-dvpn daemon set --split-mode off|include|exclude --split-apps &quot;C:\a.exe;C:\b.exe&quot;|none --split-routes &quot;10.0.0.0/8&quot;|none --yes</div>
        <div>devnet-dvpn daemon set --whole-device true|false --yes</div>
        <div>devnet-dvpn proxy on --yes | proxy off | proxy browser</div>
      </div>
      </Section>
      </div>
      </div>

      {/* ── Apply bar (Proton: Apply when disconnected, reconnect when connected) ── */}
      {dirty && (
        <div className="sticky bottom-0 z-30 -mx-2 rounded-lg border border-line bg-[var(--glass)] px-4 py-3 shadow-card backdrop-blur" data-split-apply>
          <div className="flex items-center justify-end gap-3">
            <span className="mr-auto text-meta text-fg-muted">{invalid ? <span className="text-bad">{invalid.replace(/^split /, '').replace(/^./, (c) => c.toUpperCase())}.</span> : s ? 'Applying restarts the VPN service and ends this session. Connect again after.' : 'Applying restarts the VPN service (one administrator prompt).'}</span>
            <button className="btn-ghost" disabled={applying} onClick={reset}>Reset</button>
            <button className="btn-primary" disabled={applying || !!invalid} onClick={() => void apply()}>{applying ? 'Applying…' : s ? 'Apply and disconnect' : 'Apply (administrator)'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Lane({ id, title, items, iconOf, end, tone }: { id: 'vpn' | 'direct'; title: string; items: LaneItem[]; iconOf: (p?: string) => string | null; end: ReactNode; tone: 'ok' | 'muted' }) {
  return (
    <div className={`flex flex-col rounded-lg border p-4 ${tone === 'ok' ? 'border-ok/40 bg-ok-soft' : 'border-line bg-bg-raised'}`} data-lane={id}>
      <div className={`mb-2 text-label font-semibold uppercase ${tone === 'ok' ? 'text-ok' : 'text-fg-muted'}`}>{title}</div>
      <ul className="mb-3 flex-1 space-y-2 text-sm">
        {items.length === 0 ? <li className="text-fg-muted">Nothing</li> : items.slice(0, 8).map((it, i) => {
          const icon = iconOf(it.path);
          return (
            <li key={`${it.label}-${i}`} className="flex items-center gap-2" data-lane-item={it.path ?? it.kind}>
              {icon ? <img src={icon} alt="" className="h-4 w-4 shrink-0" /> : <span className={`h-2 w-2 shrink-0 rounded-full ${tone === 'ok' ? 'bg-ok' : 'bg-fg-muted'}`} aria-hidden />}
              <span className="truncate">{it.label}</span>
            </li>
          );
        })}
        {items.length > 8 && <li className="text-meta text-fg-muted">and {items.length - 8} more</li>}
      </ul>
      <div className="flex items-center gap-1 border-t border-line pt-2 text-meta"><span className="text-fg-dim">Sites see</span> <span className="mono">{end}</span></div>
    </div>
  );
}
