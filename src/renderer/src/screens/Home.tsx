// ─── Connect / status (F9, F11, F12, F14, F16a) ───
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, useApp } from '../lib/store';
import { byPlatform, onAndroid, thisDevice } from '../lib/platform';
import { Banner, Flag, PageHeader, Section, StatCell, StatStrip } from '../components/ui';
import { ProtocolList, ProtocolTag } from '../components/ProtocolMark';
import { ConnectSheet } from '../components/ConnectSheet';
import { formatBytes, formatDuration, formatTdvpn, tdvpn, short, countryName } from '../../../shared/format';
import type { AppSnapshot, NodeView } from '../../../shared/types';
import type { Screen } from '../App';
import { pickQuickNode } from '../../../shared/quick-pick';
import { coverageCopy } from '../../../core/session/coverage';
import { restoreInPanel, sessionWarningCopy } from '../../../core/session/state';
import { connectActionButton } from '../../../shared/connect-action';

/** The button under a "session ended" banner goes where its advice points, and says so. */
function closeAction(action: string | null, go: (s: Screen) => void): ReactNode {
  if (!action) return undefined;
  if (/fund/i.test(action)) return <button className="btn-ghost btn-sm" onClick={() => go('wallet')}>Wallet</button>;
  if (/plan/i.test(action)) return <button className="btn-ghost btn-sm" onClick={() => go('plans')}>Plans</button>;
  return <button className="btn-ghost btn-sm" onClick={() => go('nodes')}>Servers</button>;
}

export function Home({ snap, go }: { snap: AppSnapshot; go: (s: Screen) => void }) {
  const nodes = useApp((s) => s.nodes);
  const settings = useApp((s) => s.settings);
  const [sheet, setSheet] = useState<NodeView | null>(null);
  const { conn, session } = snap;
  const node = session ? nodes.find((n) => n.address === session.node) : undefined;

  // Quick connect: favourite → preferred country → lowest latency, online only.
  const quick = useMemo(() => pickQuickNode(nodes, settings?.preferredCountry ?? null), [nodes, settings?.preferredCountry]);

  const ready = snap.settlements.filter((s) => s.status === 'ready');
  const refundTotal = snap.settlements.reduce((a, s) => a + BigInt(s.refundable || '0'), 0n);
  const busyPhase = conn.phase === 'connecting' || conn.phase === 'checking' || conn.phase === 'disconnecting' || conn.phase === 'reconnecting';
  // "Protected" only when the measured exit IP says so (core/session/coverage); never just "connected".
  const live = conn.phase === 'connected';
  // Q0366 end copy: the blocked view already says why and that the kill switch is blocking; the header
  // alert would be a second kill-switch message on the same screen. One message: the button moves here.
  const explainsBlock = restoreInPanel(conn);
  // One rule for "covered" (coverageCopy().ok): device, proxy-apps and the two split states.
  const safe = live && !!snap.coverage && coverageCopy(snap.coverage).ok;
  const unsafe = live && (snap.coverage === 'proxy-only' || snap.coverage === 'leaking');
  const ip = snap.publicIp && session && snap.publicIp.sid === session.id ? snap.publicIp : null;
  // The last connect that failed or was stopped: its note (a stop is not an error) and one button.
  const lastErr = !session && (conn.phase === 'error' || conn.phase === 'idle') ? snap.lastConnectError : null;
  const errBtn = lastErr ? connectActionButton(lastErr.action) : null;
  const errNode = lastErr ? nodes.find((n) => n.address === lastErr.node) : undefined;
  const runErrAction = (): void => {
    if (!errBtn) return;
    if (errBtn.target === 'same-node') { if (errNode) setSheet(errNode); else go('nodes'); return; }
    if (errBtn.target === 'restore') { void call(window.api.IPC.RESTORE_NETWORK); return; }
    if (errBtn.target === 'disconnect') { void call(window.api.IPC.DISCONNECT); return; }
    go(errBtn.target === 'wallet' ? 'wallet' : errBtn.target === 'plans' ? 'plans' : errBtn.target === 'settings' ? 'settings' : errBtn.target === 'diagnostics' ? 'diagnostics' : 'nodes');
  };

  return (
    <div>
      <PageHeader title="Connect" subtitle="Your traffic goes straight to a node you pay directly." />

      {snap.lastCloseMessage && conn.phase === 'idle' && (
        <Banner kind="warn" action={closeAction(snap.lastCloseMessage.action, go)}>
          <span data-close-message>{snap.lastCloseMessage.message}</span>
          {snap.lastCloseMessage.action && <span className="text-fg-dim"> {snap.lastCloseMessage.action}.</span>}
        </Banner>
      )}
      {session && sessionWarningCopy(session.warning) && (
        <Banner kind="warn">
          <span data-session-warning={session.warning}>{sessionWarningCopy(session.warning)}</span>
        </Banner>
      )}
      {conn.restoreNetwork && !explainsBlock && (
        <Banner kind="error" action={<button className="btn-danger btn-sm" onClick={() => void call(window.api.IPC.RESTORE_NETWORK)}>Restore network</button>}>
          Internet may be blocked by the kill switch. Restore network releases it.
        </Banner>
      )}

      <div className="card-raised relative mb-6 overflow-hidden rounded-xl p-0" data-coverage={live ? snap.coverage ?? '' : ''}>
        <div className="pointer-events-none absolute inset-0 bg-sol-soft opacity-60" aria-hidden />
        {/* Centred stack: status ring, state, one line, actions (the connect view of leading VPN apps). */}
        <div className="relative flex flex-col items-center px-6 py-8 text-center">
          {/* Status orb: gradient ring spins while busy, glows green when connected. */}
          <div className="relative flex h-[132px] w-[132px] shrink-0 items-center justify-center">
            <div className={`absolute inset-0 rounded-full ${safe ? 'bg-ok/20 animate-breathe' : unsafe ? 'bg-warn/30' : busyPhase ? 'bg-sol animate-spin-slow' : conn.phase === 'error' ? 'bg-bad/30' : 'bg-sol opacity-40'}`} style={busyPhase ? { maskImage: 'conic-gradient(#000 0 70%, transparent)', WebkitMaskImage: 'conic-gradient(#000 0 70%, transparent)' } : undefined} aria-hidden />
            <div className={`relative flex h-[116px] w-[116px] items-center justify-center rounded-full border ${safe ? 'border-ok/50 bg-bg-card shadow-glow-green' : unsafe ? 'border-warn/60 bg-bg-card' : 'border-line-strong bg-bg-card'}`}>
              {node ? <Flag code={node.countryCode} size={44} /> : (
                <svg viewBox="0 0 24 24" className={`h-11 w-11 ${safe ? 'text-ok' : 'text-fg-muted'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 2v8M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>
              )}
            </div>
          </div>
          <div className="mt-6 min-w-0">
            <div className={`mb-1 text-label font-semibold uppercase ${safe ? 'text-ok' : unsafe ? 'text-warn' : conn.phase === 'error' ? 'text-bad' : busyPhase || live ? 'text-warn' : 'text-fg-muted'}`}>{safe ? 'Protected' : unsafe ? 'Not protected' : live ? 'Checking' : conn.phase === 'error' ? 'Problem' : busyPhase ? 'Working' : 'Your connection'}</div>
            <div className="font-display text-hero" aria-live="polite">{conn.title}</div>
            <div className="mt-1 text-sm text-fg-dim">{(lastErr ? <span data-connect-note={lastErr.code}>{lastErr.message}</span> : null) || conn.detail || (session ? `${node ? countryName(node.countryCode) : short(session.node)} · ${session.service}` : 'Pick a server or use quick connect.')}</div>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {explainsBlock && <button data-restore-network className="btn-danger" onClick={() => void call(window.api.IPC.RESTORE_NETWORK)}>Restore network</button>}
              {errBtn && <button data-connect-error-action={errBtn.target} className="btn-ghost" onClick={runErrAction}>{errBtn.label}</button>}
              {conn.canCancel && <button data-cancel-connect className="btn-ghost" onClick={() => void call(window.api.IPC.DISCONNECT, { cancel: true })}>Cancel</button>}
              {(conn.canDisconnect || conn.canStop) && <button data-disconnect className="btn-danger" onClick={() => void call(window.api.IPC.DISCONNECT)}>{conn.phase === 'reconnecting' ? 'Stop' : 'Disconnect'}</button>}
              {conn.canConnect && (
                quick
                  ? <button className="btn-primary px-6" onClick={() => setSheet(quick)}><span>Quick connect</span><span aria-hidden className="opacity-50">·</span><Flag code={quick.countryCode} size={14} /><span>{countryName(quick.countryCode)}</span></button>
                  : <button className="btn-primary px-6" onClick={() => go('nodes')}>Choose a server</button>
              )}
              {conn.canConnect && quick && errBtn?.target !== 'nodes' && <button className="btn-ghost" onClick={() => go('nodes')}>All servers</button>}
            </div>
          </div>
        </div>
      </div>

      {session && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {node && <span className="chip"><Flag code={node.countryCode} /> {countryName(node.countryCode)}</span>}
            {ip?.viaProxy && !onAndroid() ? (
              <>
                <span className="chip" title="What sites see from apps that use the VPN proxy."><span className="text-fg-muted">{snap.proxyActive ? 'Browsers' : 'Proxy apps'}</span> {ip.ip}</span>
                <span className={`chip ${ip.directIp && ip.directIp === snap.homeIp ? 'text-warn' : ''}`} title="What sites see from apps that do not use the proxy."><span className="text-fg-muted">Other apps</span> {ip.directIp ?? 'unknown'}</span>
              </>
            ) : snap.coverage === 'split-include' ? (
              // The app is not one of the chosen apps, so its own IP check exits direct: show the server instead.
              <span className="chip" title="Where the apps you chose exit."><span className="text-fg-muted">Chosen apps exit at</span> {ip?.nodeIp ?? 'the server'}</span>
            ) : (
              <span className={`chip ${snap.coverage === 'leaking' ? 'text-warn' : ''}`} title={`What sites see from ${thisDevice()} now.`}><span className="text-fg-muted">Sites see</span> {ip?.ip ?? 'checking…'}</span>
            )}
            {snap.homeIp && <span className="chip" title="Measured while not connected."><span className="text-fg-muted">Your own IP</span> {snap.homeIp}</span>}
            <span className="chip"><span className="text-fg-muted">Protocol</span> {session.service ? <ProtocolTag protocol={session.service} size={18} /> : '—'}</span>
            {snap.dns && <span className="chip"><span className="text-fg-muted">DNS</span> {snap.dns}</span>}
          </div>
          <StatStrip>
            <StatCell label="Time" value={<SessionClock startedAt={session.startedAt} metered={Number(session.seconds)} />} />
            <StatCell label="Downloaded" value={formatBytes(session.rxBytes)} hint="Approximate · every minute" />
            <StatCell label="Uploaded" value={formatBytes(session.txBytes)} hint="Approximate · every minute" />
            <StatCell label="Spent" value={`${tdvpn(session.spent)} tDVPN`} hint="Every minute · includes the prepaid first block" />
          </StatStrip>
          {session.proxyEndpoint && !onAndroid() && (
            <div className={`card mb-4 ${snap.proxyActive ? '' : 'border-warn/40'}`}>
              <div className="label">Which apps use the VPN</div>
              <p className="mb-3 text-sm text-fg-dim">{snap.proxyActive
                ? byPlatform('Browsers and apps that follow the Windows proxy use the VPN. Apps that ignore it use your normal connection.', 'Apps that follow the VPN proxy setting use the VPN. Apps that ignore it use your normal connection.')
                : 'Only apps you point at the VPN proxy use it. Your browser and other apps use your normal connection.'}</p>
              <div className="flex flex-wrap items-center gap-2">
                {!snap.proxyActive && <button className="btn-primary" onClick={async () => {
                  try { await call(window.api.IPC.PROXY_SET, { on: true }); } catch (err) { console.warn('proxy on failed', err); }
                }}>Send apps through the VPN</button>}
                <button className="btn-ghost" onClick={() => go('split')}>Split tunnelling</button>
              </div>
            </div>
          )}
          <div className="mb-6 text-meta text-fg-muted">Session {short(session.id)} · deposit {short(session.channel)}</div>
        </>
      )}

      {!session && (
        <StatStrip>
          <StatCell label="Wallet" value={`${formatTdvpn(snap.wallet?.ownerTdvpn ?? '0')} tDVPN`} hint={snap.wallet && BigInt(snap.wallet.userBalance) > 0n ? `${tdvpn(snap.wallet.userBalance)} refundable` : undefined} />
          <StatCell label="Servers online" value={nodes.filter((n) => n.probe?.ok).length || '—'} hint={`${nodes.length} listed`} />
          {/* The amount, like Activity "Coming back": a count of settled deposits read as money when most return 0 (VM 2026-10-22: "110 ready" next to Wallet "0"). */}
          <StatCell label="Coming back" value={refundTotal > 0n ? `${formatTdvpn(refundTotal.toString())} tDVPN` : 'Nothing'} hint={snap.settlements.length ? `${snap.settlements.length} deposit${snap.settlements.length === 1 ? '' : 's'} still open or closing${ready.length ? ` · ${ready.length} ready to settle` : ''}` : 'Unused deposits come back automatically.'} />
        </StatStrip>
      )}

      {/* Fills the lower half the way leading VPN apps do: your servers one click away. */}
      <QuickPicks nodes={nodes} canConnect={conn.canConnect} current={session?.node ?? null} onPick={setSheet} />

      {sheet && <ConnectSheet node={sheet} snap={snap} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** Favourites and recent servers first; with none yet, the fastest online servers. Up to 6 rows. */
function QuickPicks({ nodes, canConnect, current, onPick }: { nodes: NodeView[]; canConnect: boolean; current: string | null; onPick: (n: NodeView) => void }): JSX.Element | null {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { call<string[]>(window.api.IPC.RECENT_NODES, undefined, { quiet: true }).then(setRecent, () => setRecent([])); }, []);
  const mine = nodes.filter((n) => n.favourite || recent.includes(n.address));
  const fastest = nodes.filter((n) => n.probe?.ok).sort((a, b) => (a.probe?.latencyMs ?? 9e9) - (b.probe?.latencyMs ?? 9e9));
  const rows = (mine.length ? [...mine].sort((a, b) => Number(b.favourite) - Number(a.favourite)) : fastest).slice(0, 6);
  if (!rows.length) return null;
  return (
    <Section title={mine.length ? 'Your servers' : 'Fastest right now'}>
      <div className="card overflow-hidden p-0">
        <table className="dtable">
          <thead><tr><th>Server</th><th>Protocol</th><th className="n">Response</th><th className="w-px" aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.address} data-quick-pick={n.address}>
                <td><span className="flex items-center gap-2">{n.favourite && <span className="text-warn" aria-label="Favourite">★</span>}<Flag code={n.countryCode} /> {n.probe?.city || countryName(n.countryCode)} <span className="mono text-fg-muted">{short(n.address)}</span></span></td>
                <td><ProtocolList names={n.protocolNames} /></td>
                <td className={`n ${n.probe?.ok ? 'text-ok' : 'text-fg-muted'}`}>{n.probe?.ok ? `${n.probe.latencyMs ?? '?'} ms` : 'Offline'}</td>
                <td className="text-right"><button className="btn-ghost btn-sm" disabled={!n.probe?.ok || !canConnect || current === n.address} onClick={() => onPick(n)}>Connect</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Ticks every second from the session start; the daemon's metered seconds move only once a minute. */
function SessionClock({ startedAt, metered }: { startedAt: number | null; metered: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = startedAt ? Math.max(metered, Math.floor((now - startedAt) / 1000)) : metered;
  return <>{formatDuration(secs)}</>;
}
