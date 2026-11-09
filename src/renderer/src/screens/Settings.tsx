// ─── Settings (F4, F14, F15, F16b, F18) ───
// Two stores: app settings (instant, local) and VPN-service settings (one
// administrator prompt + service restart, applied together).
import { cloneElement, isValidElement, useEffect, useState } from 'react';
import { call, useApp } from '../lib/store';
import { byPlatform, onAndroid, thisDevice } from '../lib/platform';
import { Banner, ConfirmModal, PageHeader, Section, Switch } from '../components/ui';
import { PollSettings } from '../components/PollSettings';
import { GB_OPTIONS, HOUR_OPTIONS, countryName } from '../../../shared/format';
import { DNS_CUSTOM, DNS_PRESETS, dnsPresetKey, dnsSelectChange, dnsSelectValue } from '../../../core/daemon/dns-presets';
import type { AppSettings } from '../../../shared/types';
import { maskRpcKey, unmaskRpcUrls } from '../../../shared/rpc-mask';
import { prepayHint } from '../../../shared/prepay-cap';
import type { DaemonSettings } from '../../../core/daemon/config';
import { tdvpn, toBaseUnits } from '../../../core/chain/amounts';

const baseToTdvpn = (v: string | undefined): string => (v ? tdvpn(v) : '');
/** A positive tDVPN amount -> base units, or null. */
function escrowToBase(t: string): string | null {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t) || Number(t) <= 0) return null;
  return toBaseUnits(t);
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-6 border-b border-line px-4 py-3 last:border-0">
      <div className="min-w-0"><div className="text-sm">{label}</div>{hint && <div className="prose-cap mt-1 text-meta text-fg-muted">{hint}</div>}</div>
      <div className="shrink-0">{named(children, label)}</div>
    </div>
  );
}

/** A row with one input or select: give it the row's label (screen readers, F25.3). */
function named(children: React.ReactNode, label: string): React.ReactNode {
  if (!isValidElement<{ 'aria-label'?: string }>(children)) return children;
  if (children.type !== 'input' && children.type !== 'select') return children;
  if (children.props['aria-label']) return children;
  return cloneElement(children, { 'aria-label': label });
}

/** Asks each chosen DNS server one question (DNS_PROBE = CLI `daemon dns-check`); warns before Apply when none answers. */
function DnsCheck({ servers }: { servers: string[] }) {
  const [state, setState] = useState<{ key: string; problem: string | null; ok: number } | null>(null);
  const key = servers.join(',');
  useEffect(() => {
    if (!servers.length) { setState(null); return; }
    let live = true;
    const t = setTimeout(() => {
      call<{ rows: Array<{ ok: boolean }>; problem: string | null }>(window.api.IPC.DNS_PROBE, { servers }, { quiet: true })
        .then((r) => { if (live) setState({ key, problem: r.problem, ok: r.rows.filter((x) => x.ok).length }); })
        .catch((err) => console.warn('dns probe failed', err));
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state || state.key !== key) return <span className="text-meta text-fg-muted" data-dns-check="checking">Checking these servers…</span>;
  return state.problem
    ? <span className="max-w-xs text-right text-meta text-warn" role="alert" data-dns-check="dead">None of these servers answered from {thisDevice()}. Names may not work during a session: pick another.</span>
    : <span className="num text-meta text-ok" data-dns-check="ok">{state.ok} of {servers.length} answer</span>;
}

/** About: the version and the Sentinel attribution (Sentinel dVPN License §4: shown where users see it). */
function About() {
  const [version, setVersion] = useState('');
  const [notices, setNotices] = useState<string | null>(null);
  const openNotices = (): void => {
    // Shipped next to index.html (scripts/android-notices.mjs).
    fetch('./THIRD-PARTY-NOTICES.txt')
      .then((r) => { if (!r.ok) throw new Error(`Notices: http ${r.status}`); return r.text(); })
      .then(setNotices)
      .catch((err) => { console.warn('notices failed', err); useApp.getState().toast('warn', 'The licence notices could not be opened.'); });
  };
  useEffect(() => {
    call<{ version: string }>(window.api.IPC.APP_INFO, undefined, { quiet: true })
      .then((i) => setVersion(i.version))
      .catch((err) => console.warn('app info failed', err));
  }, []);
  return (
    <Section title="About">
      <div className="card text-sm" data-about>
        <p>Devnet dVPN{version && <span className="num text-fg-muted"> {version}</span>} · Solana devnet</p>
        <p className="mt-2">
          Built on Sentinel.{' '}
          <button className="text-accent-ink underline" onClick={() => void call(window.api.IPC.OPEN_EXTERNAL, 'https://sentinel.co/')}>sentinel.co</button>
        </p>
        <p className="mt-2 text-meta text-fg-muted">The VPN service (dvpnd) and the Sentinel protocol files are under the Sentinel dVPN License. The other open-source parts are under their own licences.</p>
        <button className="btn-ghost btn-sm mt-3" data-notices-open onClick={openNotices}>Open-source licences</button>
      </div>
      {notices !== null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Open-source licences">
          <div className="card-raised flex max-h-full w-full max-w-2xl flex-col rounded-xl p-4">
            <h2 className="mb-3 font-display text-section">Open-source licences</h2>
            <pre className="mono min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-meta text-fg-dim" data-notices>{notices}</pre>
            <div className="mt-3 flex justify-end"><button className="btn-primary" onClick={() => setNotices(null)}>Close</button></div>
          </div>
        </div>
      )}
    </Section>
  );
}

export function Settings({ go }: { go: (s: 'killswitch' | 'split') => void }) {
  const { settings, setSettings, nodes } = useApp();
  const [rpcText, setRpcText] = useState('');
  const [daemon, setDaemon] = useState<{ readable: boolean; settings: Partial<DaemonSettings> } | null>(null);
  const [draft, setDraft] = useState<Partial<DaemonSettings>>({});
  const [customDns, setCustomDns] = useState('');
  const [customDnsMode, setCustomDnsMode] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [escrowText, setEscrowText] = useState('');
  const [allowanceText, setAllowanceText] = useState('');
  // Android: notifications can be off at the system level; re-read when coming back from its settings.
  const [notifAllowed, setNotifAllowed] = useState(() => window.api.android?.notificationsAllowed() ?? true);
  useEffect(() => {
    if (!onAndroid()) return undefined;
    const reread = (): void => { if (document.visibilityState === 'visible') setNotifAllowed(window.api.android?.notificationsAllowed() ?? true); };
    document.addEventListener('visibilitychange', reread);
    window.addEventListener('focus', reread);
    return () => { document.removeEventListener('visibilitychange', reread); window.removeEventListener('focus', reread); };
  }, []);

  // Draft from the service: a saved non-preset DNS list opens in Custom with its addresses filled in.
  const loadDraft = (s: Partial<DaemonSettings>): void => {
    const custom = dnsPresetKey(s.dnsServers) === null;
    setDraft(s); setCustomDnsMode(custom); setCustomDns(custom ? (s.dnsServers ?? []).join(', ') : '');
  };

  useEffect(() => { if (settings) { setRpcText(settings.rpcUrls.map(maskRpcKey).join('\n')); setAllowanceText(settings.allowanceTdvpn); } }, [settings]);
  useEffect(() => {
    call<{ readable: boolean; settings: Partial<DaemonSettings> }>(window.api.IPC.DAEMON_SETTINGS_GET).then((d) => { setDaemon(d); loadDraft(d.settings); setEscrowText(baseToTdvpn(d.settings.escrow)); }, () => setDaemon({ readable: false, settings: {} }));
  }, []);

  if (!settings) return null;
  const set = async (patch: Partial<AppSettings>): Promise<void> => { setSettings(await call<AppSettings>(window.api.IPC.SETTINGS_SET, patch)); };
  const countries = [...new Set(nodes.map((n) => n.countryCode).filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  const presetKey = dnsSelectValue(draft.dnsServers, customDnsMode);
  const dirty = daemon && JSON.stringify(draft) !== JSON.stringify(daemon.settings);

  return (
    <div>
      <PageHeader title="Settings" subtitle="App preferences apply at once; VPN service settings apply together." />

      {/* Wide windows: app settings left, VPN service + RPC right. */}
      <div className="grid gap-x-6 xl:grid-cols-2">
      <div>
      <Section title="Connection defaults">
      <div className="card overflow-hidden p-0">
        <Row label="Default pricing" hint="Per-GB and per-hour prices are never compared; pick what suits how you browse.">
          <select className="input w-36" aria-label="Default pricing" value={settings.defaultBasis} onChange={(e) => void set({ defaultBasis: e.target.value as AppSettings['defaultBasis'] })}>
            <option value="per_gb">Per GB</option><option value="per_hour">Per hour</option>
          </select>
        </Row>
        <Row label="Default amount">
          <div className="flex gap-2">
            <select className="input w-24" value={settings.defaultGb} onChange={(e) => void set({ defaultGb: Number(e.target.value) })} aria-label="Default gigabytes">{GB_OPTIONS.map((g) => <option key={g} value={g}>{g} GB</option>)}</select>
            <select className="input w-24" value={settings.defaultHours} onChange={(e) => void set({ defaultHours: Number(e.target.value) })} aria-label="Default hours">{HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h} h</option>)}</select>
          </div>
        </Row>
        <Row label="Preferred country" hint="Used by quick connect when you have no favourites.">
          <select className="input w-48" aria-label="Preferred country" value={settings.preferredCountry ?? ''} onChange={(e) => void set({ preferredCountry: e.target.value || null })}>
            <option value="">Fastest anywhere</option>
            {countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
          </select>
        </Row>
        <Row label="Device spending limit" hint={`The most ${thisDevice()} may spend from your wallet without asking again. Used when you set up or update the device.`}>
          <div className="flex items-center gap-2 text-sm">
            <input className="input mono w-24 text-right" inputMode="decimal" value={allowanceText} onChange={(e) => setAllowanceText(e.target.value.replace(/[^\d.]/g, ''))} onBlur={() => { if (escrowToBase(allowanceText)) { if (allowanceText !== settings.allowanceTdvpn) void set({ allowanceTdvpn: allowanceText }); } else { useApp.getState().toast('warn', 'Device spending limit: use a positive tDVPN amount, e.g. 50.'); setAllowanceText(settings.allowanceTdvpn); } }} aria-label="Device spending limit, tDVPN" /> tDVPN
          </div>
        </Row>
      </div>
      </Section>

      <Section title="App">
      <div className="card overflow-hidden p-0">
        {/* Android: the VPN service keeps running with its notification; start at boot = Always-on VPN (Kill switch screen). */}
        {!onAndroid() && <Row label="Start with Windows"><Switch label="Start with Windows" checked={settings.startWithOs} onChange={(on) => void set({ startWithOs: on })} /></Row>}
        {!onAndroid() && <Row label="Keep running in the tray when closed"><Switch label="Keep running in the tray when closed" checked={settings.closeToTray} onChange={(on) => void set({ closeToTray: on })} /></Row>}
        <Row label="Connect on launch" hint="Uses quick connect. Never resumes on its own after a crash."><Switch label="Connect on launch" checked={settings.autoConnect} onChange={(on) => void set({ autoConnect: on })} /></Row>
        <Row label="Top up this device's SOL automatically" hint="When it runs low before you connect, send it 0.05 SOL from your wallet for network fees. Only with the wallet saved in this app."><Switch label="Top up this device's SOL automatically" checked={settings.autoTopUpDevice} onChange={(on) => void set({ autoTopUpDevice: on })} /></Row>
        <Row label="Notifications" hint={byPlatform('Only while the window is hidden: dropped connection, refunds, low balance.', 'Only while the app is in the background: dropped connection, refunds, low balance.')}><Switch label="Notifications" checked={settings.notifications} onChange={(on) => void set({ notifications: on })} /></Row>
        {onAndroid() && settings.notifications && !notifAllowed && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-meta text-warn">
            <span>Android has notifications turned off for this app, so none will show.</span>
            <button className="btn-ghost btn-sm" onClick={() => window.api.android?.openNotificationSettings()}>Turn on in Android settings</button>
          </div>
        )}
        <Row label="IP check and speed test" hint="These contact third-party services (ipify, Cloudflare). Off = never contacted."><Switch label="IP check and speed test" checked={settings.thirdPartyChecks} onChange={(on) => void set({ thirdPartyChecks: on })} /></Row>
        <Row label="Theme">
          <select className="input w-32" aria-label="Theme" value={settings.theme} onChange={(e) => void set({ theme: e.target.value as AppSettings['theme'] })}>
            <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
          </select>
        </Row>
      </div>
      </Section>

      <Section title="Background refresh">
        <PollSettings settings={settings} />
      </Section>
      </div>

      <div>
      <Section title="Solana RPC (this app)">
      <div className="card">
        <p className="mb-2 text-meta text-fg-muted">One per line, tried in order; rate-limited endpoints are skipped for a while. https only (http only for 127.0.0.1).</p>
        <textarea className="input mono mb-2 h-24" value={rpcText} onChange={(e) => setRpcText(e.target.value)} spellCheck={false} aria-label="RPC endpoints" />
        <button className="btn-ghost" onClick={async () => {
          const urls = unmaskRpcUrls(rpcText.split(/\s+/).map((u) => u.trim()).filter(Boolean), settings?.rpcUrls ?? []);
          const next = await call<AppSettings>(window.api.IPC.SETTINGS_SET, { rpcUrls: urls });
          setSettings(next);
          const dropped = urls.filter((u) => !next.rpcUrls.includes(u));
          useApp.getState().toast(dropped.length ? 'warn' : 'success', dropped.length ? `Ignored ${dropped.length} invalid endpoint(s).` : 'RPC endpoints saved.');
        }}>Save endpoints</button>
      </div>
      </Section>

      <Section title="VPN service">
      <p className="mb-3 text-meta text-fg-muted">The kill switch and which apps use the VPN have their own pages: <button className="text-accent-ink underline" onClick={() => go('killswitch')}>Kill switch</button> · <button className="text-accent-ink underline" onClick={() => go('split')}>Split tunnelling</button></p>
      {!daemon ? null : !daemon.readable ? <Banner kind="info">The VPN service settings can&apos;t be read yet. Install the service first.</Banner> : (
        <div className="card overflow-hidden p-0">
          <Row label="DNS while connected" hint="Handshake resolves decentralised names as well as normal ones.">
            <div className="flex flex-col items-end gap-2">
              <select className="input w-48" aria-label="DNS while connected" value={presetKey} onChange={(e) => { const next = dnsSelectChange(e.target.value, draft.dnsServers); setCustomDnsMode(next.customMode); setCustomDns(next.customMode ? next.dnsServers.join(', ') : ''); setDraft({ ...draft, dnsServers: next.dnsServers }); }}>
                {Object.entries(DNS_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                <option value={DNS_CUSTOM}>Custom</option>
              </select>
              {presetKey === DNS_CUSTOM && <input className="input mono w-48" placeholder="1.1.1.1, 9.9.9.9" value={customDns} onChange={(e) => { setCustomDns(e.target.value); setDraft({ ...draft, dnsServers: e.target.value.split(/[\s,]+/).filter(Boolean) }); }} aria-label="Custom DNS servers" />}
              <DnsCheck servers={draft.dnsServers ?? []} />
            </div>
          </Row>
          <Row label="Use the VPN's DNS" hint={draft.dnsMode === 'none' ? `Off: ${byPlatform('Windows keeps', 'the phone keeps')} its own DNS servers during a session. Your DNS provider can see the sites you look up.` : `On: during a session, ${byPlatform('Windows asks', 'the phone asks')} the DNS servers above, through the VPN.`}>
            <Switch label="Use the VPN's DNS" checked={draft.dnsMode !== 'none'} onChange={(on) => setDraft({ ...draft, dnsMode: on ? byPlatform('netsh', 'vpn') : 'none' })} />
          </Row>
          <Row label="Prepaid first block" hint={prepayHint(draft.prepayBytes, draft.prepaySeconds)}>
            <div className="flex items-center gap-2 text-sm">
              <input className="input w-24" inputMode="numeric" value={String(Math.round(Number(draft.prepayBytes ?? 0) / 1e6))} onChange={(e) => setDraft({ ...draft, prepayBytes: String(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) * 1e6) })} aria-label="Prepaid megabytes" /> MB
              <input className="input w-20" inputMode="numeric" value={String(Math.round(Number(draft.prepaySeconds ?? 0) / 60))} onChange={(e) => setDraft({ ...draft, prepaySeconds: String(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) * 60) })} aria-label="Prepaid minutes" /> min
            </div>
          </Row>
          <Row label="Service defaults" hint="Used only for sessions started outside this app (the dvpnd command line). The app always sends its own amount.">
            <div className="flex items-center gap-2 text-sm">
              <select className="input w-28" value={draft.basis ?? 'per_gb'} onChange={(e) => setDraft({ ...draft, basis: e.target.value as DaemonSettings['basis'] })} aria-label="Service default pricing">
                <option value="per_gb">Per GB</option><option value="per_hour">Per hour</option>
              </select>
              <input className="input mono w-24 text-right" inputMode="decimal" value={escrowText} onChange={(e) => setEscrowText(e.target.value.replace(/[^\d.]/g, ''))} onBlur={() => { const v = escrowToBase(escrowText); if (v) setDraft({ ...draft, escrow: v }); else setEscrowText(baseToTdvpn(draft.escrow)); }} aria-label="Service default deposit, tDVPN" /> tDVPN
            </div>
          </Row>
          <Row label="Service RPC" hint="The service talks to Solana itself. API keys are hidden here and kept unless you change the URL.">
            <input className="input mono w-64" value={draft.rpcUrl ?? ''} onChange={(e) => setDraft({ ...draft, rpcUrl: e.target.value.trim(), rpcWsUrl: e.target.value.trim().replace(/^https:/, 'wss:') })} aria-label="Service RPC URL" />
          </Row>
          <div className="flex items-center justify-end gap-2 border-t border-line bg-bg-raised/40 px-4 py-3">
            {dirty && <span className="mr-auto text-meta text-fg-muted">Applying restarts the service and ends any session.</span>}
            <button className="btn-ghost" disabled={!dirty || applying} onClick={() => loadDraft(daemon.settings)}>Reset</button>
            <button className="btn-primary" disabled={!dirty || applying} onClick={async () => {
              setApplying(true);
              try {
                await call(window.api.IPC.DAEMON_SETTINGS_APPLY, { ...daemon.settings, ...draft });
                const d = await call<{ readable: boolean; settings: Partial<DaemonSettings> }>(window.api.IPC.DAEMON_SETTINGS_GET);
                setDaemon(d); loadDraft(d.settings);
                useApp.getState().toast('success', 'VPN service settings applied.');
              } catch (err) { console.warn('apply failed', err); } finally { setApplying(false); }
            }}>{applying ? 'Applying…' : byPlatform('Apply (administrator)', 'Apply')}</button>
          </div>
        </div>
      )}
      </Section>

      <About />

      {/* "Restore default settings": app preferences only; the VPN service has its own Reset above. */}
      <div className="card mb-6 flex items-center justify-between gap-4 text-sm">
        <span className="text-fg-muted">Put this app&apos;s settings back to how they were at install. Favourites and RPC endpoints are kept.</span>
        <button className="btn-ghost shrink-0" data-settings-reset onClick={() => setConfirmReset(true)}>Restore default settings</button>
      </div>
      </div>
      </div>
      {confirmReset && (
        <ConfirmModal
          title="Restore default settings?"
          lines={['Pricing, amounts, preferred country, start-up, tray, notifications, checks, theme, background refresh and the device spending limit go back to their defaults.', 'Favourites and RPC endpoints are kept. VPN service settings are not changed.']}
          confirmLabel="Restore defaults"
          onConfirm={async () => { setSettings(await call<AppSettings>(window.api.IPC.SETTINGS_RESET)); useApp.getState().toast('success', 'App settings restored to defaults.'); }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
