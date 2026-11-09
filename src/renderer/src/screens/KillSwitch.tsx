// ─── Kill switch page (owner 2026-10-22: research-led rebuild) ───
// Standards: docs/UI-STANDARDS-RESEARCH.md § Kill switch. Radio modes + one Apply (the change
// restarts the service, so no instant toggles: Microsoft/NN/g), Always asks first (Proton/Nord
// confirm on enable), a clear "Blocking internet" state with Restore network (Mullvad), the LAN
// range "Allow local network" lets through (ExpressVPN/Mullvad), and the split-tunnel interplay.
import { useEffect, useState } from 'react';
import { call } from '../lib/store';
import { useDaemonSettings } from '../lib/use-daemon-settings';
import { Banner, ConfirmModal, PageHeader, Section, Switch } from '../components/ui';
import { ProtocolTag } from '../components/ProtocolMark';
import type { AppSnapshot, KillSwitch as Mode } from '../../../shared/types';
import { killSwitchBlocksProtocol, splitNotApplied } from '../../../core/session/state';
import { KS_STATE_COPY, ksActiveStep, ksState, ksSteps } from '../../../core/session/ks-view';
import { PROTOCOLS } from '../../../shared/protocols';
import { onAndroid } from '../lib/platform';
import { KillSwitchAndroid } from './KillSwitchAndroid';

const PLATFORM = /Windows/i.test(navigator.userAgent) ? 'win32' : 'other';
const MODES: Array<{ id: Mode; name: string; copy: string }> = [
  { id: 'off', name: 'Off', copy: 'If the VPN drops, your apps carry on over your normal connection until you reconnect.' },
  { id: 'on', name: 'On', copy: 'If the VPN drops, internet is blocked until it reconnects or you disconnect. Recommended.' },
  { id: 'persist', name: 'Always', copy: 'Also keeps the block after a restart, until you reconnect or press Restore network. Strongest; can leave you offline.' },
];
const TONE = { ok: 'border-ok/40 bg-ok-soft text-ok', warn: 'border-warn/40 bg-warn-soft text-warn', bad: 'border-bad/50 bg-bad-soft text-bad', muted: 'border-line bg-bg-raised text-fg-muted' } as const;

// Android has its own page (the VPN service applies these there, not dvpnd).
export function KillSwitch({ snap }: { snap: AppSnapshot }) {
  return onAndroid() ? <KillSwitchAndroid snap={snap} /> : <DesktopKillSwitch snap={snap} />;
}

function DesktopKillSwitch({ snap }: { snap: AppSnapshot }) {
  const { daemon, draft, setDraft, dirty, applying, apply, reset } = useDaemonSettings();
  const [askAlways, setAskAlways] = useState(false);
  const [lan, setLan] = useState<string[] | null>(null);
  useEffect(() => {
    call<{ lan?: string[] }>(window.api.IPC.APP_INFO).then((i) => setLan(i.lan ?? [])).catch((err) => { console.warn('app info failed', err); setLan([]); });
  }, []);

  const mode = (draft.killSwitch ?? 'off') as Mode;
  const saved = (daemon?.settings.killSwitch ?? 'off') as Mode;
  const live = snap.session;
  const state = ksState({ phase: snap.conn.phase, restoreNetwork: snap.conn.restoreNetwork, connected: !!live, saved });
  const copy = KS_STATE_COPY[state];
  const steps = ksSteps(mode);
  const active = mode === saved ? ksActiveStep(state, !!live) : -1;
  const split = draft.split;
  const splitOn = !!split && split.mode !== 'off';
  const restore = (): void => { void call(window.api.IPC.RESTORE_NETWORK).catch((err) => console.warn('restore network failed', err)); };

  return (
    <div>
      <PageHeader title="Kill switch" subtitle="Stops your traffic leaking onto your normal connection if the VPN drops." />

      {/* ── Live state: one compact status line ── */}
      <div className={`mb-6 flex min-h-14 items-center justify-between gap-4 rounded-lg border px-4 py-3 ${TONE[copy.tone]}`} data-ks-state={state} role={state === 'blocking' ? 'alert' : 'status'}>
        <div className="min-w-0">
          <div className="font-display text-section">{copy.title}</div>
          <p className="text-sm text-fg-dim">{copy.detail}{live ? <> Connected with <ProtocolTag protocol={live.service} size={18} />.</> : null}</p>
          {live && saved !== 'off' && killSwitchBlocksProtocol(PLATFORM, saved, live.service, snap.daemon.version) && <p className="mt-1 text-meta text-warn">Not supported with this protocol on this service version.</p>}
        </div>
        {state === 'blocking' && <button className="btn-danger shrink-0" onClick={restore}>Restore network</button>}
      </div>

      {/* Wide windows: settings left, what it does + checks right. */}
      <div className="grid gap-x-6 xl:grid-cols-2">
      <div>
      {!daemon ? null : !daemon.readable ? <Banner kind="info">The VPN service settings can&apos;t be read yet. Install the service first.</Banner> : (
        <>
          {/* ── Mode ── */}
          <Section title="Mode">
          <div className="card overflow-hidden p-0" role="radiogroup" aria-label="Kill switch mode">
            {MODES.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-start gap-3 border-b border-line px-4 py-3 last:border-0 hover:bg-bg-hover" data-ks-mode={m.id}>
                <input type="radio" name="ks" className="mt-1" checked={mode === m.id} onChange={() => (m.id === 'persist' && saved !== 'persist' ? setAskAlways(true) : setDraft({ ...draft, killSwitch: m.id }))} />
                <span><span className="text-sm font-medium">{m.name}</span>{m.id === saved && <span className="pill ml-2">Current</span>}<span className="block text-meta text-fg-muted">{m.copy}</span></span>
              </label>
            ))}
          </div>
          </Section>

          {/* ── Local network ── */}
          <Section title="Local network">
          <div className="card">
            <label className="flex cursor-pointer items-start justify-between gap-4">
              <span>
                <span className="text-sm font-medium">Allow local network</span>
                <span className="block text-meta text-fg-muted">Printers, file shares and other devices at home or work stay reachable while the kill switch blocks the internet.</span>
                <span className="mt-1 block text-meta text-fg-muted" data-lan>{lan === null ? 'Finding your local network…' : lan.length ? <>Your local network: <span className="mono">{lan.join(', ')}</span></> : 'No local network found on this computer right now.'}</span>
              </span>
              <Switch label="Allow local network" checked={!!draft.allowLan} onChange={(on) => setDraft({ ...draft, allowLan: on })} />
            </label>
          </div>
          </Section>

          {splitOn && (
            <Banner kind="info">
              Split tunnelling is on ({split?.mode === 'include' ? 'only chosen apps use the VPN' : 'some apps skip the VPN'}). {mode === 'off' ? 'With the kill switch off, nothing is blocked if the VPN drops.' : splitNotApplied({ daemonVersion: snap.daemon.version, service: 'xray', killSwitch: mode, wholeDevice: true, hasApps: (split?.apps.length ?? 0) > 0, platform: PLATFORM }) ?? 'If the VPN drops, what you chose for the VPN is blocked; what you left out keeps your normal connection.'}
            </Banner>
          )}

          {dirty && (
            <div className="sticky bottom-0 z-30 mb-6 flex items-center justify-end gap-2 rounded-lg border border-line bg-[var(--glass)] px-4 py-3 shadow-card backdrop-blur" data-ks-apply>
              <span className="mr-auto text-meta text-fg-muted">{live ? 'Applying restarts the VPN service and ends this session.' : 'Applying restarts the VPN service (one administrator prompt).'}</span>
              <button className="btn-ghost" disabled={applying} onClick={reset}>Reset</button>
              <button className="btn-primary" disabled={applying} onClick={() => void apply()}>{applying ? 'Applying…' : live ? 'Apply and disconnect' : 'Apply (administrator)'}</button>
            </div>
          )}
        </>
      )}

      {/* ── Read-only check (plan U6): the service's own kill-switch rows. A real drop test cuts
          the network, so it runs only on test VMs (scripts/e2e/vm-split-ui.ps1 -Case ks). ── */}
      <Section title="Check it">
        <KsCheck />
      </Section>

      <Section title="If your internet stops working">
        <div className="card flex items-center justify-between gap-4">
          <p className="text-sm text-fg-dim">Restore network removes every block the kill switch left and puts your DNS back. Your settings stay as they are.</p>
          <button className="btn-ghost shrink-0" onClick={restore}>Restore network</button>
        </div>
      </Section>
      </div>

      <div>
      {/* ── What happens (picture for the selected mode); stacked in the right column on wide windows ── */}
      <Section title={`What happens with “${MODES.find((m) => m.id === mode)?.name}”`}>
      <ol className="grid grid-cols-3 gap-2 xl:grid-cols-1" data-ks-steps={mode}>
        {steps.map((st, i) => (
          <li key={st.label} className={`relative rounded-lg border p-4 text-sm ${i === active ? 'ring-2 ring-accent' : ''} ${st.tone === 'ok' ? 'border-ok/35' : st.tone === 'warn' ? 'border-warn/40' : 'border-bad/40'} bg-bg-card`} data-ks-step={i} aria-current={i === active ? 'step' : undefined}>
            <div className={`mb-1 text-label font-semibold uppercase ${st.tone === 'ok' ? 'text-ok' : st.tone === 'warn' ? 'text-warn' : 'text-bad'}`}>{i + 1}. {st.label}</div>
            <div className="text-fg-dim">{st.text}</div>
            {i === active && <div className="mt-2 text-meta font-medium text-accent-ink">You are here</div>}
            {i < 2 && <span className="absolute -right-2 top-1/2 z-10 -translate-y-1/2 text-fg-muted xl:hidden" aria-hidden>›</span>}
          </li>
        ))}
      </ol>
      </Section>

      {/* ── Protocols ── */}
      <Section title="Which server types it works with">
      <div className="card overflow-hidden p-0" data-ks-support>
        {PROTOCOLS.map((p) => {
          const blocked = killSwitchBlocksProtocol(PLATFORM, 'on', p, snap.daemon.version);
          return (
            <div key={p} className="flex h-12 items-center justify-between gap-4 border-b border-line px-4 text-sm last:border-0" data-ks-protocol={p}>
              <ProtocolTag protocol={p} />
              <span className={`text-right text-meta ${blocked ? 'text-warn' : 'text-ok'}`}>{blocked ? 'Not on this service version: connect is refused before paying' : 'Works'}</span>
            </div>
          );
        })}
      </div>
      </Section>

      <Section title="Command line">
      <div className="card mono leading-6">
        <div>devnet-dvpn daemon set --kill-switch off|on|persist --yes</div>
        <div>devnet-dvpn daemon set --allow-lan true|false --yes</div>
        <div>devnet-dvpn daemon restore-network</div>
        <div>devnet-dvpn status</div>
        <div>devnet-dvpn version   (shows your local network)</div>
      </div>
      </Section>
      </div>
      </div>

      {askAlways && (
        <ConfirmModal
          title="Turn on Always?"
          lines={[
            'If the VPN drops, your internet stays blocked, even after you restart the computer.',
            'It opens again only when you reconnect or press Restore network (here or in Diagnostics).',
            'Applying restarts the VPN service.',
          ]}
          confirmLabel="Use Always"
          onConfirm={() => setDraft({ ...draft, killSwitch: 'persist' })}
          onClose={() => setAskAlways(false)}
        />
      )}
    </div>
  );
}

const KS_CHECKS: Record<string, string> = { kill_switch: 'What the service holds now', kill_switch_backend: 'Firewall control (Windows Filtering Platform)', privileges: 'Service privileges' };

/** Read-only: the kill-switch rows of the service check (DAEMON_DOCTOR = CLI `daemon doctor`). Changes nothing. */
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
    <div className="card" data-ks-check={rows ? (rows.every((r) => r.level === 'ok') ? 'ok' : 'problem') : 'none'}>
      <div className="mb-2 flex items-center justify-between gap-4">
        <p className="text-sm text-fg-dim">Asks the VPN service whether its firewall control works and what it is holding. Nothing is changed and your connection is not cut.</p>
        <button className="btn-ghost shrink-0" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {rows && (rows.length ? rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[1.25rem_14rem_1fr] gap-2 border-t border-line py-2 text-sm" data-ks-check-row={r.name}>
          <span className={r.level === 'ok' ? 'text-ok' : r.level === 'warn' ? 'text-warn' : 'text-bad'} aria-label={r.level}>{r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✗'}</span>
          <span className="text-fg-dim">{KS_CHECKS[r.name]}</span>
          <span className="min-w-0 break-words text-fg-dim">{r.detail || 'OK'}</span>
        </div>
      )) : <p className="text-sm text-fg-muted">This service version reports no kill-switch checks.</p>)}
    </div>
  );
}
