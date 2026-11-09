// ─── Kill switch page, Android (owner 2026-10-22: same standard as the Windows app's research-led rebuild) ───
// Standards: docs/UI-STANDARDS-RESEARCH.md § Kill switch. Radio modes + one Apply (the change
// restarts dvpnd), Always asks first, a clear "Blocking internet" state with Restore network,
// the LAN ranges "Allow local network" leaves out (= vpn/RouteSplit.kt), Android's own
// Always-on / "Block connections without VPN" shown as it is, and a read-only check.
// Drop tests cut the network: they run on the emulator only (scripts/e2e/android/edge.sh).
import { useEffect, useState } from 'react';
import { call } from '../lib/store';
import { useDaemonSettings } from '../lib/use-daemon-settings';
import { Banner, PageHeader } from '../components/ui';
import { ProtocolTag } from '../components/ProtocolMark';
import type { AppSnapshot, KillSwitch as Mode } from '../../../shared/types';
import { killSwitchBlocksProtocol } from '../../../core/session/state';
import { KS_STATE_COPY, ksActiveStep, ksState, ksSteps } from '../../../core/session/ks-view';
import { PROTOCOLS } from '../../../shared/protocols';
import { ANDROID_LAN_RANGES } from '../../../shared/android-lan';

// One "On" (= dvpnd 'persist', Q0426): cb33 dvpnd's 'on' lifts the block whenever the engine stops
// (Android killing the app, an update, a restart), so a separate weaker mode only added a leak.
// An old 'on' config reads as On.
const MODES: Array<{ id: Mode; name: string; copy: string }> = [
  { id: 'off', name: 'Off', copy: 'If the VPN drops, apps carry on over your normal connection until you reconnect.' },
  { id: 'persist', name: 'On', copy: 'If the VPN drops or you switch servers, apps stay inside the VPN with no way out, also after the app or phone restarts, until it reconnects, you disconnect or press Restore network. Recommended.' },
];
const shown = (k: Mode | undefined): Mode => (k === 'on' ? 'persist' : k ?? 'off');
const TONE = { ok: 'border-ok/40 bg-ok-soft text-ok', warn: 'border-warn/40 bg-warn-soft text-warn', bad: 'border-bad/50 bg-bad-soft text-bad', muted: 'border-line bg-bg-raised text-fg-muted' } as const;

export function KillSwitchAndroid({ snap }: { snap: AppSnapshot }) {
  const { daemon, draft, setDraft, dirty, applying, apply, reset } = useDaemonSettings();
  const [sys, setSys] = useState<{ alwaysOn?: boolean; lockdown?: boolean }>({});
  useEffect(() => {
    const read = (): void => setSys(window.api.android?.vpnSystemState() ?? {});
    read();
    // Back from the system VPN settings: read it again.
    const onShow = (): void => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);

  const mode = shown(draft.killSwitch as Mode | undefined);
  const saved = shown(daemon?.settings.killSwitch as Mode | undefined);
  const live = snap.session;
  const state = ksState({ phase: snap.conn.phase, restoreNetwork: snap.conn.restoreNetwork, connected: !!live, saved });
  const copy = KS_STATE_COPY[state];
  const steps = ksSteps(mode);
  const active = mode === saved ? ksActiveStep(state, !!live) : -1;
  const restore = (): void => { void call(window.api.IPC.RESTORE_NETWORK).catch((err) => console.warn('restore network failed', err)); };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Kill switch" subtitle="Stops your traffic leaking onto your normal connection if the VPN drops." />

      {/* ── Live state ── */}
      <div className={`mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border px-5 py-4 ${TONE[copy.tone]}`} data-ks-state={state} role={state === 'blocking' ? 'alert' : 'status'}>
        <div className="min-w-0">
          <div className="font-display text-lg font-bold">{copy.title}</div>
          <p className="mt-0.5 text-sm text-fg-dim">{copy.detail}{live ? <> Connected with <ProtocolTag protocol={live.service} size={14} />.</> : null}</p>
          {sys.lockdown && <p className="mt-1 text-xs text-fg-dim">Android&apos;s &quot;Block connections without VPN&quot; is on too: no app gets out while no session is up.</p>}
        </div>
        {state === 'blocking' && <button className="btn-danger shrink-0" onClick={restore}>Restore network</button>}
      </div>

      {/* Android keeps a connection an app opened before the VPN came up on the normal network (Play services'
          push channel, for one): the in-app kill switch cannot close another app's connections. The system's
          lockdown does, so with the kill switch On and lockdown off, say so and offer it in one tap. */}
      {saved !== 'off' && sys.lockdown === false && (
        <div className="mb-6 rounded-xl border border-warn/40 bg-warn-soft px-5 py-4 text-sm" role="status" data-ks-lockdown-hint>
          <div className="font-semibold text-warn">Turn on Android&apos;s &quot;Block connections without VPN&quot; too</div>
          <p className="mt-1 text-fg-dim">Connections other apps opened before you connected can stay on your normal network during a session. Android closes them only when Always-on VPN and Block connections without VPN are on for this app.</p>
          <button className="btn-primary btn-sm mt-3" data-ks-lockdown-open onClick={() => window.api.android?.openVpnSettings()}>Open VPN settings</button>
        </div>
      )}

      {/* ── What happens with the selected mode ── */}
      <h2 className="mb-3 section-title">What happens with “{MODES.find((m) => m.id === mode)?.name}”</h2>
      <ol className="mb-6 grid gap-2 sm:grid-cols-3" data-ks-steps={mode}>
        {steps.map((st, i) => (
          <li key={st.label} className={`rounded-lg border p-3 text-sm ${i === active ? 'ring-2 ring-accent' : ''} ${st.tone === 'ok' ? 'border-ok/35' : st.tone === 'warn' ? 'border-warn/40' : 'border-bad/40'} bg-bg-card`} data-ks-step={i} aria-current={i === active ? 'step' : undefined}>
            <div className={`mb-1 text-xs font-semibold uppercase tracking-wider ${st.tone === 'ok' ? 'text-ok' : st.tone === 'warn' ? 'text-warn' : 'text-bad'}`}>{i + 1}. {st.label}</div>
            <div className="text-fg-dim">{st.text}</div>
            {i === active && <div className="mt-2 text-[11px] font-semibold text-accent-ink">You are here</div>}
          </li>
        ))}
      </ol>

      {!daemon ? null : !daemon.readable ? <Banner kind="info">The VPN engine settings can&apos;t be read yet. Open the app once more in a moment.</Banner> : (
        <>
          <h2 className="mb-3 section-title">Mode</h2>
          <div className="card mb-6 py-1" role="radiogroup" aria-label="Kill switch mode">
            {MODES.map((m) => (
              <label key={m.id} className="flex min-h-[48px] cursor-pointer items-start gap-3 border-b border-line py-3 last:border-0" data-ks-mode={m.id}>
                <input type="radio" name="ks" className="mt-1" checked={mode === m.id} onChange={() => setDraft({ ...draft, killSwitch: m.id })} />
                <span><span className="text-sm font-semibold">{m.name}</span>{m.id === saved && <span className="pill ml-2">Current</span>}<span className="block text-xs text-fg-muted">{m.copy}</span></span>
              </label>
            ))}
          </div>

          <h2 className="mb-3 section-title">Local network</h2>
          <div className="card mb-6">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" className="mt-1" checked={!!draft.allowLan} onChange={(e) => setDraft({ ...draft, allowLan: e.target.checked })} />
              <span>
                <span className="text-sm font-semibold">Allow local network</span>
                <span className="block text-xs text-fg-muted">Printers, Chromecast, a NAS and other devices on your Wi-Fi stay reachable, during a session and while the kill switch blocks the internet.</span>
                <span className="mt-1 block text-xs text-fg-muted" data-lan>Left outside the VPN: <span className="mono">{ANDROID_LAN_RANGES.join(', ')}</span></span>
              </span>
            </label>
          </div>

          {dirty && (
            <div className="sticky bottom-0 z-30 mb-6 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-line bg-[var(--glass)] px-4 py-3 shadow-card backdrop-blur" data-ks-apply>
              <span className="mr-auto text-xs text-fg-muted">{live ? 'Applying restarts the VPN engine and ends this session.' : 'Applying restarts the VPN engine.'}</span>
              <button className="btn-ghost" disabled={applying} onClick={reset}>Reset</button>
              <button className="btn-primary" disabled={applying} onClick={() => void apply()}>{applying ? 'Applying…' : live ? 'Apply and disconnect' : 'Apply'}</button>
            </div>
          )}
        </>
      )}

      <h2 className="mb-3 section-title">Android&apos;s own protection</h2>
      <div className="card mb-6" data-ks-system>
        <div className="mb-3 grid gap-1 text-sm">
          <div className="flex justify-between gap-3"><span>Always-on VPN</span><span className={sys.alwaysOn ? 'text-ok' : 'text-fg-muted'} data-ks-always-on>{sys.alwaysOn === undefined ? 'unknown' : sys.alwaysOn ? 'On' : 'Off'}</span></div>
          <div className="flex justify-between gap-3"><span>Block connections without VPN</span><span className={sys.lockdown ? 'text-ok' : 'text-fg-muted'} data-ks-lockdown>{sys.lockdown === undefined ? 'unknown' : sys.lockdown ? 'On' : 'Off'}</span></div>
        </div>
        <p className="mb-3 text-xs text-fg-muted">Always-on starts the VPN when the phone starts. Block connections without VPN keeps every app offline whenever no session is up (Android blocks; this app is allowed out on its own, so paying for a session still works).</p>
        <button className="btn-ghost" onClick={() => window.api.android?.openVpnSettings()}>Open VPN settings</button>
      </div>

      <h2 className="mb-3 section-title">Which server types it works with on Android</h2>
      <div className="card mb-6 py-1" data-ks-support>
        {PROTOCOLS.map((p) => {
          const blocked = killSwitchBlocksProtocol('android', 'on', p, snap.daemon.version);
          return (
            <div key={p} className="flex items-center justify-between border-b border-line py-2 text-sm last:border-0" data-ks-protocol={p}>
              <ProtocolTag protocol={p} />
              <span className={`text-xs ${blocked ? 'text-warn' : 'text-ok'}`}>{blocked ? 'Not yet: connect is refused before paying' : 'Works'}</span>
            </div>
          );
        })}
      </div>

      <h2 className="mb-3 section-title">Check it</h2>
      <KsCheck />

      <h2 className="mb-3 section-title">If your internet stops working</h2>
      <div className="card mb-6">
        <p className="mb-3 text-sm text-fg-dim">Restore network drops every block the kill switch kept and gives apps your normal connection back. Your settings stay as they are.</p>
        <button className="btn-ghost" onClick={restore}>Restore network</button>
      </div>

      <h2 className="mb-3 section-title">Command line</h2>
      <div className="card mono text-xs leading-6">
        <div>devnet-dvpn daemon set --kill-switch off|on|persist --yes</div>
        <div>devnet-dvpn daemon set --allow-lan true|false --yes</div>
        <div>devnet-dvpn daemon restore-network</div>
        <div>devnet-dvpn daemon doctor</div>
        <div>devnet-dvpn status</div>
      </div>

    </div>
  );
}

const KS_CHECKS: Record<string, string> = { kill_switch: 'What the VPN engine holds now', kill_switch_backend: 'Link to the Android VPN service', privileges: 'Engine permissions' };

/** Read-only: the kill-switch rows of the engine check (DAEMON_DOCTOR = CLI `daemon doctor`). Changes nothing. */
function KsCheck() {
  const [rows, setRows] = useState<Array<{ name: string; level: 'ok' | 'warn' | 'fail'; detail: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const all = await call<Array<{ name: string; level: 'ok' | 'warn' | 'fail'; detail: string }>>(window.api.IPC.DAEMON_DOCTOR);
      setRows(all.filter((r) => r.name in KS_CHECKS));
    } catch (err) { console.warn('kill switch check failed', err); } finally { setBusy(false); }
  };
  return (
    <div className="card mb-6" data-ks-check={rows ? (rows.every((r) => r.level === 'ok') ? 'ok' : 'problem') : 'none'}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-fg-dim">Asks the VPN engine whether it can hold the VPN and what it is holding. Nothing is changed and your connection is not cut.</p>
        <button className="btn-ghost shrink-0" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {rows && (rows.length ? rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[1.25rem_1fr] gap-x-2 border-t border-line py-1.5 text-sm" data-ks-check-row={r.name}>
          <span className={r.level === 'ok' ? 'text-ok' : r.level === 'warn' ? 'text-warn' : 'text-bad'} aria-label={r.level}>{r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✗'}</span>
          <span className="min-w-0 break-words text-fg-dim"><b className="font-semibold">{KS_CHECKS[r.name]}</b> · {r.detail || 'OK'}</span>
        </div>
      )) : <p className="text-sm text-fg-muted">The VPN engine reports no kill-switch checks.</p>)}
    </div>
  );
}
