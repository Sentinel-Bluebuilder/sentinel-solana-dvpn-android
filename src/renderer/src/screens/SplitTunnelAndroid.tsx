// ─── Split tunnelling, Android (which apps and addresses use the VPN, every protocol) ───
// The VPN service applies it (Split.kt); the desktop page drives dvpnd's split instead.
import { useEffect, useMemo, useState } from 'react';
import { call, useApp } from '../lib/store';
import { Banner, Copy, PageHeader } from '../components/ui';
import type { AppSettings, AppSnapshot } from '../../../shared/types';
import { ProtocolTag } from '../components/ProtocolMark';
import { PROTOCOLS } from '../../../shared/protocols';
import { androidLanes, type Lane } from '../../../core/split/android-lanes';
import { useDaemonSettings } from '../lib/use-daemon-settings';

type SplitMode = 'all' | 'include' | 'exclude';
interface SplitState { mode: SplitMode; packages: string[]; routeMode: SplitMode; routes: string[] }
interface AppEntry { pkg: string; label: string; system: boolean; icon?: string }

const SPLIT_MODES: Array<{ id: SplitMode; name: string; copy: string }> = [
  { id: 'all', name: 'All apps', copy: 'Every app uses the VPN.' },
  { id: 'include', name: 'Only these apps', copy: 'Only the apps you tick use the VPN. Everything else uses your normal connection.' },
  { id: 'exclude', name: 'All apps except these', copy: 'The apps you tick use your normal connection (a banking app, for example). The rest use the VPN.' },
];

const ROUTE_MODES: Array<{ id: SplitMode; name: string; copy: string }> = [
  { id: 'all', name: 'All addresses', copy: 'Everything the chosen apps send uses the VPN.' },
  { id: 'include', name: 'Only these addresses', copy: 'Only traffic to the addresses below uses the VPN. The VPN DNS servers are always included.' },
  { id: 'exclude', name: 'All addresses except these', copy: 'Traffic to the addresses below uses your normal connection (your home network, for example).' },
];
const ROUTE_OK = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

export function AndroidSplit({ snap }: { snap: AppSnapshot }) {
  const { daemon } = useDaemonSettings();
  const [saved, setSaved] = useState<SplitState | null>(null);
  const [mode, setMode] = useState<SplitMode>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [routeMode, setRouteMode] = useState<SplitMode>('all');
  const [routeText, setRouteText] = useState('');

  const load = (s: SplitState): void => { setSaved(s); setMode(s.mode); setPicked(new Set(s.packages)); setRouteMode(s.routeMode); setRouteText(s.routes.join('\n')); };
  useEffect(() => {
    void call<SplitState>(window.api.IPC.SPLIT_GET).then(load, (err) => console.warn('split get failed', err));
    void call<AppEntry[]>(window.api.IPC.SPLIT_APPS, undefined, { quiet: true }).then(setApps, (err) => { console.warn('app list failed', err); setApps([]); });
  }, []);

  const byPkg = useMemo(() => new Map((apps ?? []).map((a) => [a.pkg, a])), [apps]);
  // Chosen apps first (a long list never hides them), then the rest by name.
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = (apps ?? []).filter((a) => !f || a.label.toLowerCase().includes(f) || a.pkg.includes(f));
    return [...all.filter((a) => picked.has(a.pkg)), ...all.filter((a) => !picked.has(a.pkg))];
  }, [apps, filter, picked]);

  const list = [...picked].sort();
  const routes = [...new Set(routeText.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean))].sort();
  const badRoutes = routes.filter((r) => !ROUTE_OK.test(r));
  const appsDirty = !!saved && (mode !== saved.mode || (mode !== 'all' && list.join(',') !== saved.packages.join(',')));
  const routesDirty = !!saved && (routeMode !== saved.routeMode || (routeMode !== 'all' && routes.join(',') !== saved.routes.join(',')));
  const dirty = appsDirty || routesDirty;
  const invalid = (mode === 'include' && list.length === 0) || (routeMode === 'include' && routes.length === 0) || (routeMode !== 'all' && badRoutes.length > 0);
  const toggle = (pkg: string): void => { const n = new Set(picked); if (n.has(pkg)) n.delete(pkg); else n.add(pkg); setPicked(n); };
  const live = snap.session;
  // The live session's own basis (from its channel), so a reconnect never changes how you pay.
  const liveMode = live ? snap.settlements?.find((p) => p.channel === live.channel)?.mode : undefined;
  const reconnectBasis = liveMode === undefined ? null : liveMode === 1 ? 'per_hour' : 'per_gb'; // 1 = MODE_STREAM

  const save = async (reconnect: boolean): Promise<void> => {
    setSaving(true);
    try {
      let s = saved;
      if (appsDirty) s = await call<SplitState>(window.api.IPC.SPLIT_SET, { mode, packages: mode === 'all' ? [] : list });
      if (routesDirty) s = await call<SplitState>(window.api.IPC.SPLIT_ROUTES_SET, { mode: routeMode, routes: routeMode === 'all' ? [] : routes });
      if (s) load(s);
      if (reconnect && live && reconnectBasis) {
        // Same server, same basis: a server switch to it (F11.6) rebuilds the VPN with the new choice.
        await call(window.api.IPC.CONNECT, { node: live.node, basis: reconnectBasis, units: 1, confirmed: true, switch: true });
      } else {
        useApp.getState().toast('success', live ? 'Saved. It applies when you next connect or switch servers.' : 'Saved. It applies when you connect.');
      }
    } catch (err) { console.warn('split set failed', err); } finally { setSaving(false); }
  };

  const ip = snap.publicIp && live && snap.publicIp.sid === live.id ? snap.publicIp.ip : null;
  const lanes = saved ? androidLanes({ split: saved, allowLan: !!daemon?.settings.allowLan, live: !!live, vpnIp: ip, homeIp: snap.homeIp, appName: (p) => byPkg.get(p)?.label ?? p }) : null;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Split tunnelling" subtitle="Choose which apps and addresses use the VPN. Works with every server type." />

      {/* ── Live lanes: from the saved choice and the measured exits, never the draft ── */}
      <h2 className="mb-3 section-title">{live ? 'Where your traffic goes now' : 'Where your traffic will go'}</h2>
      {!lanes ? <div className="card mb-6 text-sm text-fg-muted">Reading…</div> : (
        <div className="mb-6 grid gap-3 sm:grid-cols-2" data-split-lanes>
          <LaneCard title="Through the VPN" tone="ok" exit={live ? (lanes.vpnExit ?? 'checking…') : 'when you connect'} items={lanes.vpn} byPkg={byPkg} lane="vpn" />
          <LaneCard title="Normal connection" tone="muted" exit={lanes.directExit ?? 'not measured yet'} items={lanes.direct} byPkg={byPkg} lane="direct" />
        </div>
      )}

      <h2 className="mb-3 section-title">Which apps</h2>
      <div className="card mb-4 py-1" role="radiogroup" aria-label="Split tunnelling mode">
        {SPLIT_MODES.map((m) => (
          <label key={m.id} className="flex min-h-[48px] cursor-pointer items-start gap-3 border-b border-line py-3 last:border-0" data-split-mode={m.id}>
            <input type="radio" name="split" className="mt-1" checked={mode === m.id} onChange={() => setMode(m.id)} />
            <span><span className="text-sm font-semibold">{m.name}</span>{saved?.mode === m.id && <span className="pill ml-2">Current</span>}<span className="block text-xs text-fg-muted">{m.copy}</span></span>
          </label>
        ))}
      </div>

      {mode !== 'all' && (
        <div className="card mb-4 p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <input className="input h-[40px] min-w-0 flex-1" placeholder="Search apps" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search apps" />
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {apps === null ? <p className="px-4 py-3 text-sm text-fg-muted">Loading apps…</p> : !shown.length ? <p className="px-4 py-3 text-sm text-fg-muted">No apps match.</p> : shown.map((a) => (
              <label key={a.pkg} className="flex min-h-[52px] cursor-pointer items-center gap-3 border-b border-line px-4 py-2 last:border-0" data-app={a.pkg}>
                <input type="checkbox" checked={picked.has(a.pkg)} onChange={() => toggle(a.pkg)} aria-label={a.label} />
                <AppIcon app={a} />
                <span className="min-w-0"><span className="block truncate text-sm">{a.label}</span><span className="mono block truncate text-[11px] text-fg-muted">{a.pkg}{a.system ? ' · preinstalled' : ''}</span></span>
              </label>
            ))}
          </div>
          <div className="border-t border-line px-4 py-2 text-xs text-fg-muted">{list.length} selected · apps without a launcher icon are not listed</div>
        </div>
      )}

      <h2 className="mb-3 section-title">Which addresses</h2>
      <div className="card mb-4 py-1" role="radiogroup" aria-label="Split by address">
        {ROUTE_MODES.map((m) => (
          <label key={m.id} className="flex min-h-[48px] cursor-pointer items-start gap-3 border-b border-line py-3 last:border-0" data-split-routes-mode={m.id}>
            <input type="radio" name="split-routes" className="mt-1" checked={routeMode === m.id} onChange={() => setRouteMode(m.id)} />
            <span><span className="text-sm font-semibold">{m.name}</span>{saved?.routeMode === m.id && <span className="pill ml-2">Current</span>}<span className="block text-xs text-fg-muted">{m.copy}</span></span>
          </label>
        ))}
      </div>
      {routeMode !== 'all' && (
        <div className="card mb-4">
          <label className="label" htmlFor="split-routes-text">IP addresses or networks, one per line (like 192.168.1.0/24 or 2001:db8::/32)</label>
          <textarea id="split-routes-text" aria-label="Addresses or networks" className="input mono min-h-[96px] w-full py-2 text-xs" value={routeText} onChange={(e) => setRouteText(e.target.value)} spellCheck={false} />
          <div className="mt-1 text-xs text-fg-muted">{routes.length} address{routes.length === 1 ? '' : 'es'}. Names like example.com are not accepted: Android routes by address.</div>
        </div>
      )}

      {mode === 'include' && list.length === 0 && <Banner kind="warn">Tick at least one app, or choose All apps.</Banner>}
      {routeMode === 'include' && routes.length === 0 && <Banner kind="warn">Add at least one address, or choose All addresses.</Banner>}
      {routeMode !== 'all' && badRoutes.length > 0 && <Banner kind="warn">{`Not an IP address or network: ${badRoutes.slice(0, 3).join(', ')}`}</Banner>}

      {/* ── Sticky Apply bar: one primary action, and it says what applying does ── */}
      {dirty && (
        <div className="sticky bottom-0 z-30 mb-6 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-line bg-[var(--glass)] px-4 py-3 shadow-card backdrop-blur" data-split-apply>
          <span className="mr-auto text-xs text-fg-muted">{live ? (reconnectBasis ? 'Apply and reconnect rebuilds the VPN on the same server, paid the same way.' : 'Saved choices apply when you next connect or switch servers.') : 'Applies when you connect.'}</span>
          <button className="btn-ghost" disabled={saving} onClick={() => { if (saved) load(saved); }}>Reset</button>
          {live && reconnectBasis
            ? <><button className="btn-ghost" disabled={saving || invalid} onClick={() => void save(false)}>Save only</button><button className="btn-primary" disabled={saving || invalid} onClick={() => void save(true)}>{saving ? 'Applying…' : 'Apply and reconnect'}</button></>
            : <button className="btn-primary" disabled={saving || invalid} onClick={() => void save(false)}>{saving ? 'Saving…' : 'Apply'}</button>}
        </div>
      )}

      <h2 className="mb-3 section-title">Which server types it works with on Android</h2>
      <div className="card mb-3 py-1" data-split-support>
        {PROTOCOLS.map((p) => (
          <div key={p} className="flex items-center justify-between border-b border-line py-2 text-sm last:border-0" data-split-protocol={p}>
            <ProtocolTag protocol={p} />
            <span className="text-xs text-ok">Apps and addresses</span>
          </div>
        ))}
      </div>
      <p className="mb-6 text-xs text-fg-muted">Android itself keeps each app on its chosen side. This app always pays nodes over your normal connection, so paying works whatever you choose. With the kill switch on, a dropped VPN blocks what you sent through it; what you left out keeps working.</p>

      <h2 className="mb-3 section-title">Command line</h2>
      <div className="card mono text-xs leading-6">
        <div>devnet-dvpn split show</div>
        <div>devnet-dvpn split apps</div>
        <div>devnet-dvpn split set all|include|exclude [package…]</div>
        <div>devnet-dvpn split routes all|include|exclude [address…]</div>
      </div>
    </div>
  );
}

function AppIcon({ app }: { app: AppEntry }) {
  return app.icon
    ? <img src={`data:image/png;base64,${app.icon}`} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-md" />
    : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-bg-raised text-xs font-semibold text-fg-muted" aria-hidden>{app.label.slice(0, 1).toUpperCase()}</span>;
}

function LaneCard({ title, tone, exit, items, byPkg, lane }: { title: string; tone: 'ok' | 'muted'; exit: string; items: Lane[]; byPkg: Map<string, AppEntry>; lane: string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, 5);
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone === 'ok' ? 'border-ok/40 bg-ok-soft' : 'border-line bg-bg-raised'}`} data-lane={lane}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-sm font-semibold ${tone === 'ok' ? 'text-ok' : 'text-fg'}`}>{title}</span>
        <span className="mono text-[11px] text-fg-muted" data-lane-exit>exits at {exit}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((it) => {
          const a = it.pkg ? byPkg.get(it.pkg) : undefined;
          return <li key={it.pkg ?? it.label} className="flex items-center gap-2 text-sm text-fg-dim">{a ? <AppIcon app={a} /> : null}<span className="truncate">{it.label}</span></li>;
        })}
      </ul>
      {items.length > 5 && <button className="mt-1 text-xs text-accent-ink underline" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </div>
  );
}
