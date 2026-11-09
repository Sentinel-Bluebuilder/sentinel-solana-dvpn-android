// ─── Activity: refunds (F12), spend (F13.4), history (F13.5), service records (F13.1–F13.3) ───
import { useEffect, useState } from 'react';
import { settleToast, topUpToast } from '../../../shared/money-toast';
import { call, useApp } from '../lib/store';
import { ConfirmModal, CopyAddr, PageHeader, Section, StatCell, StatStrip } from '../components/ui';
import { when } from '../lib/when';
import { ProtocolList, ProtocolTag } from '../components/ProtocolMark';
import { tdvpn, formatTdvpn, short, formatBytes, formatCountdown, closeReasonCopy } from '../../../shared/format';
import type { AppSnapshot, HistoryEntry, PendingSettlement, LiveSession } from '../../../shared/types';
import type { DaemonChannel, DaemonTicket } from '../../../core/daemon/client';
import type { Screen } from '../App';

const STATUS_COPY: Record<PendingSettlement['status'], string> = {
  'in-use': 'In use by the current session',
  open: 'Open — will start closing',
  closing: 'Closing',
  ready: 'Ready to refund',
};

interface Lists { sessions: LiveSession[]; channels: DaemonChannel[]; tickets: DaemonTicket[]; error: string | null }
interface Summary { sessions: number; spent: string; bytes: string; last30Spent: string }
type Tab = 'history' | 'sessions' | 'channels' | 'tickets';

/** One deposit: server (protocol logo when the server is known), status, refund; Top up while open. */
function RefundRow({ s, now, onTopUp }: { s: PendingSettlement; now: number; onTopUp?: () => void }) {
  const node = useApp((st) => st.nodes.find((n) => n.address === s.node));
  return (
    <div className="flex min-h-14 items-center gap-4 border-b border-line px-4 py-2 last:border-0" data-refund={s.channel}>
      <div className="min-w-0 flex-1">
        {/* mode 0 = voucher (per GB), 1 = stream (per hour) — chain/idl MODE_* */}
        <div className="flex items-center gap-2 text-sm">{s.mode === 0 ? 'Per-GB' : 'Per-hour'} deposit to {node?.protocolNames?.length ? <ProtocolList names={node.protocolNames} /> : null}<span className="mono text-fg-muted">{short(s.node)}</span></div>
        <div className="text-meta text-fg-muted">{STATUS_COPY[s.status]}{s.status === 'closing' && s.readyAt ? ` · ready in ${formatCountdown((s.readyAt * 1000 - now) / 1000)}` : ''}</div>
      </div>
      {/* Amount, then the row's action at the very end (actions line up down the list). */}
      <div className="num w-36 text-right text-sm">{formatTdvpn(s.refundable)} tDVPN<div className="text-meta text-fg-muted">of {tdvpn(s.escrow)} tDVPN</div></div>
      <div className="flex w-20 justify-end">{onTopUp && (s.status === 'open' || s.status === 'in-use') && <button className="btn-ghost btn-sm" onClick={onTopUp}>Top up</button>}</div>
    </div>
  );
}

export function Activity({ snap, go }: { snap: AppSnapshot; go: (s: Screen) => void }) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [tab, setTab] = useState<Tab>('history');
  const [confirm, setConfirm] = useState(false);
  const [fund, setFund] = useState<{ channel: string; amount: string } | null>(null);
  const now = Date.now();

  useEffect(() => {
    call<HistoryEntry[]>(window.api.IPC.HISTORY_LIST).then(setHistory, () => setHistory([]));
    call<Summary>(window.api.IPC.SPEND_SUMMARY).then(setSummary, () => setSummary(null));
  }, [snap.session?.id]);
  useEffect(() => {
    if (tab !== 'history') call<Lists>(window.api.IPC.ACTIVITY_LISTS).then(setLists, () => setLists(null));
  }, [tab, snap.session?.id]);

  const actionable = snap.settlements.filter((s) => s.status === 'ready' || s.status === 'open');
  const refundTotal = snap.settlements.reduce((a, s) => a + BigInt(s.refundable || '0'), 0n);
  const canTopUp = (s: PendingSettlement): boolean => s.status === 'open' || s.status === 'in-use';
  const worth = snap.settlements.filter((s) => BigInt(s.refundable || '0') > 0n || canTopUp(s));
  const spent = snap.settlements.filter((s) => !worth.includes(s));

  return (
    <div>
      <PageHeader title="Activity" subtitle="Deposits waiting to be refunded, what you spent, and every session." />

      <StatStrip>
        <StatCell label="Sessions" value={summary?.sessions ?? '—'} />
        <StatCell label="Spent" value={summary ? `${formatTdvpn(summary.spent)} tDVPN` : '—'} hint={summary ? `last 30 days ${formatTdvpn(summary.last30Spent)} tDVPN` : undefined} />
        <StatCell label="Data" value={summary ? formatBytes(summary.bytes) : '—'} />
        <StatCell label="Coming back" value={`${formatTdvpn(refundTotal)} tDVPN`} hint={`${snap.settlements.length} ${snap.settlements.length === 1 ? 'deposit' : 'deposits'}`} />
      </StatStrip>

      <Section title="Refunds" right={<button className="btn-ghost btn-sm" disabled={!actionable.length} onClick={() => setConfirm(true)}>Settle now</button>}>
      {!snap.settlements.length ? <div className="empty-box">Nothing pending. Unused deposits come back automatically.</div> : (
        <div className="card overflow-hidden p-0">
          {/* Money first: deposits that still return something or can be topped up. The rest (fully
              used, they only close) fold into one line — 266 rows of "0 tDVPN" buried the 2 that mattered. */}
          <div data-refunds="open">
            {worth.length === 0 ? <div className="empty-line">No deposit has anything left to refund.</div> : worth.map((s) => <RefundRow key={s.channel} s={s} now={now} onTopUp={() => setFund({ channel: s.channel, amount: '1' })} />)}
          </div>
          {spent.length > 0 && (
            <details className="border-t border-line" data-refunds="used">
              <summary className="disclosure flex h-12 cursor-pointer items-center px-4 text-sm text-fg-muted hover:bg-bg-hover">{spent.length} fully used deposit{spent.length === 1 ? '' : 's'}: nothing comes back, they close on their own</summary>
              {spent.map((s) => <RefundRow key={s.channel} s={s} now={now} />)}
            </details>
          )}
        </div>
      )}
      </Section>

      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1" role="tablist" aria-label="Records">
          {(['history', 'sessions', 'channels', 'tickets'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
              {t === 'history' ? 'History' : t === 'sessions' ? 'Service sessions' : t === 'channels' ? 'Deposits' : 'Plan tickets'}
            </button>
          ))}
        </div>
        {tab === 'history' && <button className="btn-ghost btn-sm" disabled={!history?.length} onClick={() => void call(window.api.IPC.HISTORY_EXPORT)}>Export CSV</button>}
      </div>

      {tab === 'history' && (!history?.length ? <div className="empty-box justify-between gap-4" data-empty-history>No sessions yet. Each one you connect shows here with its server, time, data and cost.<button className="btn-ghost btn-sm shrink-0" onClick={() => go('nodes')}>Find a server</button></div> : (
        <div className="card overflow-x-auto p-0">
          <table className="dtable">
            <thead>
              <tr><th>Started</th><th>Server</th><th>Protocol</th><th className="n">Data</th><th className="n">Spent (tDVPN)</th><th>Ended</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="num whitespace-nowrap">{when(h.startedAt)}</td>
                  <td>{h.country || '—'} <span className="text-fg-muted"><CopyAddr text={h.node} /></span></td>
                  <td>{h.service ? <ProtocolTag protocol={h.service} /> : '—'}</td>
                  <td className="n">{formatBytes((BigInt(h.rxBytes || '0') + BigInt(h.txBytes || '0')).toString())}</td>
                  <td className="n">{formatTdvpn(h.spent)}</td>
                  <td className="text-meta text-fg-dim">{h.endedAt ? (h.closeReason ? closeReasonCopy(h.closeReason).message.replace(/\.$/, '') : 'ended') : 'active'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {tab !== 'history' && (
        !lists ? <div className="empty-box">Loading…</div> : lists.error ? <div className="empty-box text-bad">{lists.error}</div> : (
          <div className="card overflow-hidden p-0">
            {tab === 'sessions' && (lists.sessions.length ? lists.sessions.map((s) => (
              <Row key={s.id} left={<>{short(s.node)} · {s.service ? <ProtocolTag protocol={s.service} size={18} /> : '—'}</>} sub={`${s.status}${s.error ? ` · ${closeReasonCopy(s.error).message}` : ''}`} right={`${tdvpn(s.spent)} tDVPN`} />
            )) : <Empty text="The service has no sessions." />)}
            {tab === 'channels' && (lists.channels.length ? lists.channels.map((c) => (
              <Row key={c.address} left={<CopyAddr text={c.address} />} sub={`${c.status} · ${Number(c.mode) === 0 ? 'per GB' : 'per hour'} · server ${short(c.node)}`} right={`${tdvpn(c.cumulative)} / ${tdvpn(c.escrow)} tDVPN`} />
            )) : <Empty text="The service holds no deposits." />)}
            {tab === 'tickets' && (lists.tickets.length ? lists.tickets.map((t) => (
              <Row key={t.hash} left={<span className="mono">{t.hash.slice(0, 16)}…</span>} sub={`subscription ${short(t.subscription)} · server ${short(t.node)}`} right={t.expiresAt && t.expiresAt !== '0' ? `until ${new Date(Number(t.expiresAt) * 1000).toLocaleTimeString()}` : ''} />
            )) : <Empty text="No plan tickets." />)}
          </div>
        )
      )}

      {confirm && (
        <ConfirmModal
          title="Settle deposits"
          lines={['Starts closing open deposits and finishes the ones that are ready.', 'Your wallet signs one transaction per step; refunds go to your wallet.', 'Network: Solana devnet (test tokens).']}
          confirmLabel="Settle"
          onConfirm={async () => { const sigs = await call<string[]>(window.api.IPC.SETTLE_RUN, { confirmed: true }); useApp.getState().toast('success', settleToast(sigs)); }}
          onClose={() => setConfirm(false)}
        />
      )}
      {fund && (
        <ConfirmModal
          title="Top up deposit"
          lines={[
            <label key="a" className="flex items-center gap-2">Add <input className="input w-28" inputMode="decimal" value={fund.amount} onChange={(e) => setFund({ ...fund, amount: e.target.value.replace(/[^0-9.]/g, '') })} aria-label="Amount" /> tDVPN</label>,
            'Lets the current deposit keep paying this server. Unused deposit is refunded after settlement.',
            'Network: Solana devnet (test tokens).',
          ]}
          confirmLabel="Top up"
          onConfirm={async () => { await call(window.api.IPC.CHANNEL_FUND, { channel: fund.channel, tdvpn: fund.amount, confirmed: true }); useApp.getState().toast('success', topUpToast(fund.amount)); }}
          onClose={() => setFund(null)}
        />
      )}
    </div>
  );
}

function Row({ left, sub, right }: { left: React.ReactNode; sub: string; right: string }) {
  return (
    <div className="flex min-h-14 items-center gap-4 border-b border-line px-4 py-2 text-sm last:border-0">
      <div className="min-w-0 flex-1"><div>{left}</div><div className="text-meta text-fg-muted">{sub}</div></div>
      <div className="num text-right text-fg-dim">{right}</div>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <div className="empty-line">{text}</div>;
