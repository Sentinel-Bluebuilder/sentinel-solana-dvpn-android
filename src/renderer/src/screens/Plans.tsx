// ─── Plans & subscriptions (F10) ───
// Subscribe directly to any provider's plan; connect to any node on its roster.
import { useEffect, useState } from 'react';
import { call, useApp } from '../lib/store';
import { ConfirmModal, CopyAddr, PageHeader, Section, Skeleton, Flag } from '../components/ui';
import { ProtocolList } from '../components/ProtocolMark';
import { ConnectSheet } from '../components/ConnectSheet';
import { tdvpn, formatTdvpn, short, formatCountdown, plural, formatPeriod as duration } from '../../../shared/format';
import type { AppSnapshot, PlanRecord, NodeView, SubscriptionRecord } from '../../../shared/types';

import type { RosterEntry } from '../../../core/plans/plans';


export function Plans({ snap }: { snap: AppSnapshot }) {
  const nodes = useApp((s) => s.nodes);
  const [plans, setPlans] = useState<PlanRecord[] | null>(null);
  const [confirm, setConfirm] = useState<PlanRecord | null>(null);
  const [closing, setClosing] = useState<SubscriptionRecord | null>(null);
  const [roster, setRoster] = useState<{ sub: SubscriptionRecord; list: RosterEntry[] | null; held: string[]; error?: string } | null>(null);
  const [sheet, setSheet] = useState<{ node: NodeView; sub: SubscriptionRecord } | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const now = Math.floor(Date.now() / 1000);

  useEffect(() => { call<PlanRecord[]>(window.api.IPC.PLANS_LIST).then(setPlans, () => setPlans([])); }, []);
  // Q0319: a subscription made in the CLI or on another device shows now, not at the next 600 s poll.
  const refreshSubs = async (quiet = false): Promise<void> => {
    setRefreshing(true);
    try { await call(window.api.IPC.SUBSCRIPTIONS_REFRESH, undefined, { quiet }); } catch (err) { console.warn('subscriptions refresh failed', err); } finally { setRefreshing(false); }
  };
  useEffect(() => { void refreshSubs(true); }, []); // on open: quiet; the Refresh button shows a failure

  const openRoster = async (sub: SubscriptionRecord): Promise<void> => {
    setRoster({ sub, list: null, held: [] });
    // Tickets the service holds for this plan: a plan's server limit counts them until they expire.
    const held = await call<{ tickets: Array<{ node: string; subscription: string; expiresAt: string }> }>(window.api.IPC.ACTIVITY_LISTS, undefined, { quiet: true })
      .then((l) => l.tickets.filter((t) => t.subscription === sub.address && Number(t.expiresAt) * 1000 > Date.now()).map((t) => t.node), () => [] as string[]);
    try { setRoster({ sub, held, list: await call<RosterEntry[]>(window.api.IPC.PLAN_ROSTER, { provider: sub.provider, plan: sub.plan }, { quiet: true }) }); } catch (err) { setRoster({ sub, held, list: [], error: (err as Error).message }); }
  };

  // Ended subscriptions fold into one line: they only need a Remove now and then.
  const live = snap.subscriptions.filter((s) => s.active && s.expiresAt - now > 0);
  const ended = snap.subscriptions.filter((s) => !(s.active && s.expiresAt - now > 0));
  const subRow = (s: SubscriptionRecord): JSX.Element => {
    const left = s.expiresAt - now;
    return (
      <div key={s.address} className="flex min-h-14 items-center gap-4 border-t border-line px-4 py-2 first:border-t-0">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Plan <CopyAddr text={s.plan} /></div>
          <div className="text-meta text-fg-muted">{s.active && left > 0 ? `${formatCountdown(left)} left` : 'Expired'} · provider {short(s.provider)}</div>
        </div>
        {s.active && left > 0 && <button data-roster={s.address} className="btn-primary btn-sm" onClick={() => void openRoster(s)}>Servers</button>}
        <button className="btn-ghost btn-sm" onClick={() => setClosing(s)}>{left > 0 ? 'Cancel' : 'Remove'}</button>
      </div>
    );
  };

  return (
    <div>
      <PageHeader title="Plans" subtitle="Subscribe to a provider's plan and connect to any of its servers." />

      <Section title="Your subscriptions" right={<button className="btn-ghost btn-sm" data-plans-refresh disabled={refreshing} onClick={() => void refreshSubs()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>}>
        <div className={snap.subscriptions.length ? 'card overflow-hidden p-0' : ''}>
          {!snap.subscriptions.length && <div className="empty-box">No subscriptions yet.</div>}
          {live.map(subRow)}
          {ended.length > 0 && (
            <button className={`flex h-12 w-full items-center gap-2 px-4 text-left text-sm text-fg-dim hover:bg-bg-hover ${live.length ? 'border-t border-line' : ''}`} aria-expanded={showEnded} onClick={() => setShowEnded(!showEnded)}>
              <svg viewBox="0 0 24 24" className={`h-4 w-4 text-fg-muted transition-transform ${showEnded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
              <span className="num">{plural(ended.length, 'ended subscription')}</span>
            </button>
          )}
          {showEnded && ended.map(subRow)}
        </div>
      </Section>

      <Section title="Available plans">
        {!plans ? <Skeleton rows={3} /> : !plans.filter((p) => p.listed).length ? <div className="empty-box">No plans are listed on devnet right now.</div> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {plans.filter((p) => p.listed).map((p) => (
              <div key={p.address} className="card flex min-w-0 flex-col gap-3">
                {/* What you get leads; the price sits on the right like a value. */}
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="font-display text-section">{duration(p.durationSeconds)}</div>
                  <div className="num font-display text-value">{formatTdvpn(p.price)} <span className="text-meta text-fg-muted">tDVPN</span></div>
                </div>
                <div className="text-sm text-fg-dim">{p.dataCapGb ? `${p.dataCapGb} GB` : 'unlimited data'} · {p.maxConnections ? plural(p.maxConnections, 'server') : 'any number of servers'}</div>
                <div className="mt-auto flex items-center justify-between gap-4">
                  <span className="mono truncate text-fg-muted">Provider {short(p.provider)}{p.providerListed ? '' : ' · not listed'}{p.providerAnswering === false ? ' · provider offline' : ''}</span>
                  <button className="btn-ghost btn-sm" disabled={!p.providerListed} onClick={() => setConfirm(p)}>Subscribe</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {confirm && (
        <ConfirmModal
          title="Subscribe to plan"
          lines={[`Pay ${tdvpn(confirm.price)} tDVPN from your wallet now.`, `Valid for ${duration(confirm.durationSeconds)} from now. Plans don't renew; you can buy again after it ends.`, 'Cancelling early does not refund the price.', 'Network: Solana devnet (test tokens).']}
          confirmLabel={`Pay ${tdvpn(confirm.price)} tDVPN`}
          onConfirm={async () => { await call(window.api.IPC.SUBSCRIBE, { plan: confirm.address, confirmed: true }); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {closing && (
        <ConfirmModal
          title={closing.expiresAt > now ? 'Cancel subscription' : 'Remove subscription'}
          danger={closing.expiresAt > now}
          lines={[closing.expiresAt > now ? 'Access ends now and the price is not refunded.' : 'Removes the ended subscription and returns its account rent.']}
          confirmLabel={closing.expiresAt > now ? 'Cancel subscription' : 'Remove'}
          onConfirm={async () => { await call(window.api.IPC.SUBSCRIBE, { close: closing.address, confirmed: true }); }}
          onClose={() => setClosing(null)}
        />
      )}
      {roster && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Plan servers">
          <div className="card max-h-[80vh] w-full max-w-lg overflow-y-auto p-6">
            <h2 className="mb-2 font-display text-section">Servers on this plan</h2>
            {roster.sub.maxConnections > 0 && (
              <p className="mb-4 text-meta text-fg-dim">
                This plan gives access on {plural(roster.sub.maxConnections, 'server')}. Access to a server lasts until the plan ends.
                {new Set(roster.held).size >= roster.sub.maxConnections ? ' All of it is in use, so only the servers marked “Your access” can be used.' : ''}
              </p>
            )}
            {!roster.list ? <Skeleton rows={3} /> : roster.error ? <p className="text-sm text-bad">{roster.error}</p> : !roster.list.length ? <p className="text-sm text-fg-dim">The provider lists no servers for this plan.</p> : (
              <div className="space-y-1">
                {roster.list.map((r) => {
                  const n = nodes.find((x) => x.address === r.node);
                  return (
                    <div key={r.node} className="flex min-h-12 items-center gap-3 rounded px-2 py-2 hover:bg-bg-hover">
                      {n && <Flag code={n.countryCode} />}
                      <span className="min-w-0 flex-1 truncate"><span className="mono">{short(r.node, 8)}</span> <span className="text-meta text-fg-muted">{n && <ProtocolList names={n.protocolNames} />}</span></span>
                      {roster.held.includes(r.node) && <span className="pill">Your access</span>}
                      {!r.live && <span className="text-meta text-fg-muted">provider: offline</span>}
                      <button data-plan-connect={r.node} className="btn-primary btn-sm" disabled={!n?.probe?.ok || !snap.conn.canConnect || (!roster.held.includes(r.node) && roster.sub.maxConnections > 0 && new Set(roster.held).size >= roster.sub.maxConnections)} onClick={() => { if (n) { setSheet({ node: n, sub: roster.sub }); setRoster(null); } }}>{!n?.probe?.ok ? 'Offline' : !roster.held.includes(r.node) && roster.sub.maxConnections > 0 && new Set(roster.held).size >= roster.sub.maxConnections ? 'Limit reached' : 'Connect'}</button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 text-right"><button className="btn-ghost" onClick={() => setRoster(null)}>Close</button></div>
          </div>
        </div>
      )}
      {sheet && <ConnectSheet node={sheet.node} snap={snap} subscription={{ provider: sheet.sub.provider, subscription: sheet.sub.address }} onClose={() => setSheet(null)} />}
    </div>
  );
}
