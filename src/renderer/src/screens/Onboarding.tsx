// ─── First run (F1.5, F2, F3): wallet → device → permission → service ───
// Order is forced by dvpnd: the service refuses to start until the device key
// holds an on-chain permission, so the elevated install is the LAST step.
import { notReadyReason, deviceSolCopy } from '../../../core/session/setup-gate';
import { useEffect, useReducer, useState } from 'react';
import { call, useApp } from '../lib/store';
import { t } from '../lib/strings';
import { byPlatform } from '../lib/platform';
import { AppMark, Banner, ConfirmModal, Copy, DevnetBadge } from '../components/ui';
import { formatTdvpn, sol, tdvpn } from '../../../shared/format';
import type { AppSnapshot } from '../../../shared/types';
import { pickCheckPositions, wrongPhraseWords } from '../../../shared/phrase-check';
import { initialPlanDialog, planDialog, type PlanDialog, type PlanEvent } from '../../../shared/plan-dialog';

export type Step = 'wallet' | 'device' | 'permission' | 'service' | 'done';

export function onboardingStep(s: AppSnapshot): Step {
  if (!s.hasWallet) return 'wallet';
  if (!s.daemon.device && !s.wallet?.device) return 'device';
  if (s.wallet && !s.wallet.ready) return 'permission';
  if (!s.daemon.reachable) return 'service';
  return 'done';
}

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'wallet', label: t('onb.wallet') },
  { id: 'device', label: t('onb.device') },
  { id: 'permission', label: 'Spending permission' },
  { id: 'service', label: t('onb.service') },
];

export function Onboarding({ snap, onContinue }: { snap: AppSnapshot; onContinue?: () => void }) {
  // Held here, not in WalletStep: creating the wallet advances the step at once.
  const [phrase, setPhrase] = useState<string | null>(null);
  const step = onboardingStep(snap);
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="grid h-full grid-cols-1 min-[880px]:grid-cols-[minmax(320px,0.9fr)_1.1fr]" data-onboarding-step={onContinue ? 'welcome' : step}>
      {/* Brand side (F2.1): what this is, in three lines. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-bg-card p-10 min-[880px]:flex">
        <div className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-sol-purple/25 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -right-20 h-72 w-72 rounded-full bg-sol-green/15 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <AppMark size={40} />
          <div>
            <div className="font-display text-section font-semibold tracking-[-0.01em]">Devnet <span className="bg-sol bg-clip-text text-transparent">dVPN</span></div>
            <div className="text-meta text-fg-muted">Built on Solana</div>
          </div>
        </div>
        <div className="relative">
          <h1 className="font-display text-hero">{t('onb.title')}</h1>
          <p className="mt-4 text-sm text-fg-dim">{t('app.tagline')}</p>
          <ul className="mt-8 space-y-4 text-sm">
            {[
              ['Peer to peer', 'You connect straight to a node run by anyone, anywhere.'],
              ['Pay only for use', 'A refundable deposit; the node is paid per GB or per hour.'],
              ['Your keys', `No account. Your wallet stays encrypted on this ${byPlatform('computer', 'phone')}.`],
            ].map(([h, d]) => (
              <li key={h} className="flex gap-3">
                <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sol text-label font-semibold text-sol-ink" aria-hidden>✓</span>
                <div><div className="font-display font-semibold">{h}</div><div className="text-fg-dim">{d}</div></div>
              </li>
            ))}
          </ul>
        </div>
        <div className="relative hidden md:block"><DevnetBadge /></div>
      </aside>
      <section className="flex flex-col justify-center overflow-y-auto p-6 min-[880px]:p-10">
        <div className="mx-auto w-full max-w-xl">
          {/* Narrow window: the brand side is hidden, so name the app here. */}
          <div className="mb-6 flex items-center gap-3 min-[880px]:hidden">
            <AppMark size={32} />
            <div className="font-display text-section font-semibold tracking-[-0.01em]">Devnet <span className="bg-sol bg-clip-text text-transparent">dVPN</span></div>
            <div className="ml-auto"><DevnetBadge /></div>
          </div>
          {onContinue ? <div className="card-raised rounded-xl p-6"><WelcomeBack snap={snap} onContinue={onContinue} /></div> : <>
          <ol className="mb-6 grid grid-cols-4 gap-3" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s.id} aria-current={i === at ? 'step' : undefined}>
                <div className={`mb-2 h-1 rounded-full ${i < at ? 'bg-ok' : i === at ? 'bg-sol' : 'bg-bg-hover'}`} />
                <div className={`min-w-0 break-words text-label font-semibold uppercase leading-snug ${i < at ? 'text-ok' : i === at ? 'text-fg' : 'text-fg-muted'}`}>{i < at ? '✓ ' : `${i + 1} · `}{s.label}</div>
              </li>
            ))}
          </ol>
          <div className="card-raised rounded-xl p-4 md:p-6">
            {phrase ? <PhraseCard phrase={phrase} onDone={() => setPhrase(null)} /> : step === 'wallet' && <WalletStep onCreated={setPhrase} />}
            {!phrase && step === 'device' && <DeviceStep snap={snap} />}
            {!phrase && step === 'permission' && <PermissionStep snap={snap} />}
            {!phrase && step === 'service' && <ServiceStep snap={snap} />}
          </div>
          </>}
        </div>
      </section>
    </div>
  );
}

// F2.1: the welcome screen comes first on every launch, even when set up. One click on.
function WelcomeBack({ snap, onContinue }: { snap: AppSnapshot; onContinue: () => void }) {
  const [confirmOut, setConfirmOut] = useState(false);
  const w = snap.wallet;
  return (
    <div>
      <h2 className="mb-4 font-display text-title">Welcome back</h2>
      <div className="label mb-1">Your wallet</div>
      <div className="mono mb-4 flex items-center gap-2 break-all text-sm text-fg-dim">{snap.owner} {snap.owner && <Copy text={snap.owner} />}</div>
      {w && <div className="mb-5 flex flex-wrap gap-2 text-sm"><span className="chip">{formatTdvpn(w.ownerTdvpn)} tDVPN</span><span className="chip">{sol(w.ownerLamports)} SOL</span>{w.userBalance !== '0' && <span className="chip">{formatTdvpn(w.userBalance)} refundable</span>}</div>}
      <div className="flex gap-2">
        <button className="btn-primary" data-welcome-continue onClick={onContinue} autoFocus>Continue</button>
        <button className="btn-ghost" onClick={() => setConfirmOut(true)}>Use a different wallet</button>
      </div>
      {confirmOut && (
        <ConfirmModal title="Use a different wallet?" confirmLabel="Remove this wallet" danger
          lines={[`This removes the encrypted key from this ${byPlatform('computer', 'phone')}.`, 'You can restore it later only with its recovery phrase or key file.', 'Funds stay on chain; nothing is sent.']}
          onClose={() => setConfirmOut(false)}
          onConfirm={async () => { setConfirmOut(false); await call(window.api.IPC.WALLET_LOGOUT); }} />
      )}
    </div>
  );
}

// Q0297: "I saved it" leads to a check of a few words by position; a wrong or empty word keeps the card open.
// Hooks: data-phrase-word="N" (phrase card), data-phrase-check, data-phrase-ask="N" (input, 1-based),
// data-phrase-check-submit, data-phrase-wrong (error). The words are not in the DOM while the check shows.
function PhraseCard({ phrase, onDone }: { phrase: string; onDone: () => void }) {
  const [checking, setChecking] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [wrong, setWrong] = useState<number[]>([]);
  // Android: keep the phrase (and the check step) out of screenshots and the Recents thumbnail. No-op elsewhere.
  useEffect(() => {
    window.api.android?.setSecure(true);
    return () => window.api.android?.setSecure(false);
  }, []);
  if (checking) {
    return (
      <div data-phrase-check>
        <h2 className="mb-2 font-display text-section">Check your recovery phrase</h2>
        <p className="mb-3 text-sm text-fg-dim">Type these words from what you wrote down, so a missed or mis-copied word is caught now.</p>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          {positions.map((p, i) => (
            <div key={p}>
              <label className="label" htmlFor={`pw${p}`}>Word {p + 1}</label>
              <input id={`pw${p}`} data-phrase-ask={p + 1} aria-label={`Word ${p + 1}`} className={`input mono ${wrong.includes(p) ? 'border-bad' : ''}`} value={answers[i] ?? ''} autoComplete="off" autoCapitalize="none" spellCheck={false}
                onChange={(e) => { const next = [...answers]; next[i] = e.target.value; setAnswers(next); setWrong([]); }} />
            </div>
          ))}
        </div>
        {wrong.length > 0 && <p className="mb-3 text-sm text-bad" role="alert" data-phrase-wrong={wrong.map((p) => p + 1).join(',')}>{wrong.length === 1 ? `Word ${wrong[0] + 1} does not match` : `Words ${wrong.map((p) => p + 1).join(', ')} do not match`}. Check what you wrote down, or show the phrase again.</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => { setChecking(false); setWrong([]); }}>Show the phrase again</button>
          <button className="btn-primary" data-phrase-check-submit onClick={() => { const bad = wrongPhraseWords(phrase, positions, answers); if (bad.length) setWrong(bad); else onDone(); }}>Check</button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2 className="mb-2 font-display text-section">Write down your recovery phrase</h2>
      <p className="mb-3 text-sm text-fg-dim">It is the only way to restore this wallet. Anyone with it controls your funds. After the check below it is never shown again.</p>
      <div className="mono mb-4 grid grid-cols-3 gap-2 sm:grid-cols-4 rounded border border-line bg-bg-input p-3">
        {phrase.split(' ').map((w, i) => <span key={i} data-phrase-word={i + 1}><span className="text-fg-muted">{i + 1}.</span> {w}</span>)}
      </div>
      <button className="btn-primary" onClick={() => {
        if (!positions.length) setPositions(pickCheckPositions(phrase.trim().split(/\s+/).length));
        setAnswers([]); setChecking(true);
      }}>I saved it</button>
    </div>
  );
}

function WalletStep({ onCreated }: { onCreated: (phrase: string) => void }) {
  const [mode, setMode] = useState<'choose' | 'import'>('choose');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  if (mode === 'import') {
    return (
      <div>
        <h2 className="mb-2 font-display text-section">Import a wallet</h2>
        <label className="label" htmlFor="imp">Recovery phrase, key file contents (JSON array) or base58 secret key</label>
        <textarea id="imp" className="input mono mb-3 h-24" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setMode('choose')}>Back</button>
          <button className="btn-primary" disabled={!input.trim() || busy} onClick={async () => {
            setBusy(true);
            try { await call(window.api.IPC.WALLET_IMPORT, input.trim()); setInput(''); } catch (err) { console.warn('import failed', err); } finally { setBusy(false); }
          }}>Import</button>
        </div>
        <p className="mt-3 text-meta text-fg-muted">{byPlatform('The key is encrypted with Windows (DPAPI) and stays on this computer.', 'The key is encrypted with the Android Keystore and stays on this phone.')}</p>
      </div>
    );
  }
  return (
    <div>
      <h2 className="mb-2 font-display text-section">Set up your wallet</h2>
      <p className="mb-4 text-sm text-fg-dim">Your wallet pays nodes directly in tDVPN. There is no account and no sign-up.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try { const r = await call<{ mnemonic: string }>(window.api.IPC.WALLET_CREATE); onCreated(r.mnemonic); } catch (err) { console.warn('create failed', err); } finally { setBusy(false); }
        }}>Create a new wallet</button>
        <button className="btn-ghost" onClick={() => setMode('import')}>Import a wallet</button>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <button className="text-sm text-accent-ink underline-offset-2 hover:underline" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await call(window.api.IPC.WALLET_IMPORT_FILE, undefined, { quiet: true }); } catch (err) { if ((err as { code?: string }).code !== 'cancelled') useApp.getState().toast('error', (err as Error).message); } finally { setBusy(false); }
        }}>Import a key file (devnet test wallet)…</button>
        <p className="mt-1 text-meta text-fg-muted">A solana-keygen JSON file. It is read here and encrypted with {byPlatform('Windows', 'the Android Keystore')}; it is not copied anywhere.</p>
      </div>
    </div>
  );
}

function DeviceStep({ snap }: { snap: AppSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [addr, setAddr] = useState('');
  if (snap.daemon.reachable) {
    return (
      <div>
        <h2 className="mb-2 font-display text-section">Use the VPN service on this {byPlatform('computer', 'phone')}</h2>
        <p className="mb-4 text-sm text-fg-dim">A VPN service is already running here. The app needs its device address to give it a spending permission.</p>
        {!manual ? (
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { await call(window.api.IPC.DAEMON_INIT, { step: 'adopt' }, { quiet: true }); } catch (err) { console.warn('detect failed', err); setManual(true); } finally { setBusy(false); }
            }}>{busy ? 'Reading…' : 'Find device address'}</button>
            <button className="btn-ghost" onClick={() => setManual(true)}>Enter it</button>
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="dev">Device address (from the service's setup output)</label>
            <input id="dev" className="input mono mb-3" value={addr} onChange={(e) => setAddr(e.target.value.trim())} spellCheck={false} />
            <button className="btn-primary" disabled={!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)} onClick={() => void call(window.api.IPC.DAEMON_INIT, { step: 'adopt', device: addr })}>Use this device</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      <h2 className="mb-2 font-display text-section">Create this device&apos;s key</h2>
      <p className="mb-4 text-sm text-fg-dim">The VPN service signs usage payments with its own device key, so your wallet key never has to be online for a session.{byPlatform(' This step needs no administrator rights.', '')}</p>
      <button className="btn-primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await call(window.api.IPC.DAEMON_INIT, { step: 'init' }); } catch (err) { console.warn('device init failed', err); } finally { setBusy(false); }
      }}>{busy ? 'Creating…' : 'Create device key'}</button>
    </div>
  );
}

type SetupPlan = { steps: string[]; topUpLamports: number };
const setupDialog = (s: PlanDialog<SetupPlan>, e: PlanEvent<SetupPlan>): PlanDialog<SetupPlan> => planDialog(s, e);

function PermissionStep({ snap }: { snap: AppSnapshot }) {
  const [allowance, setAllowance] = useState('50');
  // The dialog keeps the plan it opened with: the plan reloads on every balance change, and a
  // failed reload must not remove an open dialog (Q0317).
  const [dlg, dispatch] = useReducer(setupDialog, undefined, initialPlanDialog<SetupPlan>);
  const plan = dlg.plan;
  const [checking, setChecking] = useState(false);
  const w = snap.wallet;
  const loadPlan = (refresh: boolean): Promise<void> =>
    call<SetupPlan>(window.api.IPC.DEVICE_SETUP_PLAN, { allowance, refresh }, { quiet: true }).then(
      (p) => dispatch({ type: 'loaded', plan: p }),
      (err) => { console.warn('device setup plan failed', err); dispatch({ type: 'failed', error: (err as Error).message || 'The permission could not be prepared. Check again in a moment.' }); },
    );
  useEffect(() => {
    const id = setTimeout(() => { void loadPlan(false); }, 300);
    return () => clearTimeout(id);
  }, [allowance, w?.grant?.allowance, w?.delegated, w?.ownerLamports]);
  // A brand-new wallet has no SOL, and the Wallet screen is not reachable during setup:
  // show the address and the faucet right here (owner stuck here 2026-10-21).
  const lowSol = !!w && w.ownerLamports < 20_000_000;
  return (
    <div>
      {notReadyReason(w) === 'device-sol' && w && (
        <p className="mb-3 rounded border border-warn/40 bg-warn-soft p-2 text-sm text-warn" data-device-sol-low>{deviceSolCopy(w.deviceLamports)} Signing below tops it up; your permission is already in place.</p>
      )}
      <h2 className="mb-2 font-display text-section">{notReadyReason(w) === 'device-sol' ? 'Top up this device' : 'Let this device pay nodes'}</h2>
      <p className="mb-3 text-sm text-fg-dim">One transaction, signed by your wallet: a spending limit for this device, a token permission for the protocol, and a little SOL for the device&apos;s transaction fees. You can change or revoke it any time.</p>
      {w?.device && <p className="mono mb-3 text-fg-muted">Device {w.device} <Copy text={w.device} /></p>}
      {!w && <Banner kind="warn">Your balance could not be read yet (the network is busy). Check again in a moment.</Banner>}
      {lowSol && (
        <div className="mb-3 rounded-lg border border-line p-3 text-sm" data-fund-wallet>
          <p className="mb-2 text-fg-dim">Your wallet has {sol(w?.ownerLamports ?? 0)} SOL. It needs about 0.02 devnet SOL for network fees. Send free devnet SOL to:</p>
          <p className="mono mb-2 flex items-center gap-2 break-all">{snap.owner} {snap.owner && <Copy text={snap.owner} />}</p>
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" onClick={() => void call(window.api.IPC.OPEN_EXTERNAL, 'https://faucet.solana.com/')}>Open the devnet SOL faucet</button>
            <button className="btn-ghost btn-sm" disabled={checking} onClick={async () => { setChecking(true); try { await loadPlan(true); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
        </div>
      )}
      {!w && <button className="btn-ghost btn-sm mb-3" disabled={checking} onClick={async () => { setChecking(true); try { await loadPlan(true); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Check again'}</button>}
      <label className="label" htmlFor="allow">Device spending limit (tDVPN)</label>
      <input id="allow" className="input mb-3 w-40" inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value.replace(/[^0-9.]/g, ''))} />
      <p className="mb-4 text-meta text-fg-muted">Wallet: {formatTdvpn(w?.ownerTdvpn ?? '0')} tDVPN · {sol(w?.ownerLamports ?? 0)} SOL</p>
      {dlg.error && <p className="mb-3 text-sm text-bad" role="alert" data-plan-error>{dlg.error}</p>}
      <button className="btn-primary" disabled={!plan || !plan.steps.length || lowSol} onClick={() => dispatch({ type: 'open' })}>Review and sign</button>
      {dlg.open && (
        <ConfirmModal
          title="Sign device permission"
          lines={[...dlg.open.steps, 'Network: Solana devnet (test tokens).']}
          confirmLabel="Sign"
          onConfirm={async () => { await call(window.api.IPC.DEVICE_SETUP, { allowance, confirmed: true }); }}
          onClose={() => dispatch({ type: 'close' })}
        />
      )}
    </div>
  );
}

function ServiceStep({ snap }: { snap: AppSnapshot }) {
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h2 className="mb-2 font-display text-section">{byPlatform('Install the VPN service', 'Start the VPN service')}</h2>
      <p className="mb-3 text-sm text-fg-dim">The service builds tunnels, guards against leaks and meters usage. {byPlatform('Windows asks for administrator permission once.', 'It runs inside this app; Android asked once to allow VPN connections.')}</p>
      {snap.daemon.error && <Banner kind="info">{snap.daemon.error}</Banner>}
      <button className="btn-primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await call(window.api.IPC.DAEMON_INIT, { step: 'install' }); } catch (err) { console.warn('service install failed', err); } finally { setBusy(false); }
      }}>{busy ? byPlatform('Waiting for Windows…', 'Starting…') : byPlatform('Install service', 'Start service')}</button>
    </div>
  );
}
