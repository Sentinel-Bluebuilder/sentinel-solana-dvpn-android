// ─── Node test (F20): real sessions on chosen servers → FAST / SLOW / FAIL ───
// Own tab, own service; shares nothing with the Connect flow except the VPN service,
// which runs one session at a time — so testing is off while you are connected (F20.2).
import { useEffect, useMemo, useState } from 'react';
import { call, useApp } from '../lib/store';
import { ConfirmModal, CopyAddr, PageHeader, Section, StatCell, StatStrip, Flag, Banner } from '../components/ui';
import { when } from '../lib/when';
import { ProtocolList, ProtocolTag } from '../components/ProtocolMark';
import { tdvpn, toBaseUnits, short } from '../../../shared/format';
import type { AppSnapshot } from '../../../shared/types';
import type { NodeTestProgress, NodeTestRun, Verdict } from '../../../core/nodetest/nodetest';

interface RunRow { id: string; startedAt: number; total: number; done: number; stopped: boolean; fast: number; slow: number; fail: number }
interface HistoryReply { runs: RunRow[]; run: NodeTestRun | null; running: NodeTestRun | null }
interface PlanReply { nodes: number; estimate: string; estimateText: string; unknown: string[] }

const VERDICT_CLASS: Record<Verdict, string> = { FAST: 'text-ok', SLOW: 'text-warn', FAIL: 'text-bad', CANCELLED: 'text-fg-muted' };
const MAX = 25;
// Server picker columns: box, flag, country, protocols, address, response (header and rows share it).
// The address keeps 104 px (its short form) on narrow windows; country and protocols give way first.
const PICK_COLS = 'grid grid-cols-[16px_20px_minmax(0,160px)_minmax(0,200px)_minmax(104px,1fr)_88px] items-center gap-3';

export function NodeTest({ snap }: { snap: AppSnapshot }) {
  const nodes = useApp((s) => s.nodes);
  const online = useMemo(() => nodes.filter((n) => n.listingFresh && n.probe?.ok), [nodes]);
  const [picked, setPicked] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanReply | null>(null);
  const [limit, setLimit] = useState('');
  // The dialog keeps the plan it opened with; a failed plan reload shows an error instead of a silent null (Q0317).
  const [confirm, setConfirm] = useState<PlanReply | null>(null);
  const [planError, setPlanError] = useState('');
  const [progress, setProgress] = useState<NodeTestProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<HistoryReply | null>(null);
  const [filter, setFilter] = useState<Verdict | 'ALL'>('ALL');
  const [sort, setSort] = useState<'order' | 'speed'>('order');
  const [open, setOpen] = useState<string | null>(null);

  const load = (id?: string): void => { call<HistoryReply>(window.api.IPC.NODE_TEST_HISTORY, id ? { id } : undefined, { quiet: true }).then(setHist, (err) => console.warn('node test history failed', err)); };
  useEffect(() => {
    load();
    return window.api.on<{ progress?: NodeTestProgress; finished?: { ok: boolean; error?: string } }>(window.api.EVENTS.NODE_TEST, (e) => {
      if (e.progress) { setProgress(e.progress); setBusy(true); }
      if (e.finished) {
        setBusy(false); setProgress(null); load();
        if (!e.finished.ok) useApp.getState().toast('error', e.finished.error ?? 'Test run failed.');
        else useApp.getState().toast('success', 'Test run finished.');
      }
    });
  }, []);
  useEffect(() => { if (hist?.running) setBusy(true); }, [hist?.running]);
  useEffect(() => {
    if (!picked.length) { setPlan(null); return; }
    call<PlanReply>(window.api.IPC.NODE_TEST_PLAN, { nodes: picked }, { quiet: true }).then(
      (p) => { setPlan(p); setLimit(tdvpn(p.estimate)); setPlanError(''); },
      (err) => { console.warn('node test plan failed', err); setPlan(null); setPlanError((err as Error).message || 'The cost could not be worked out. Pick the servers again.'); },
    );
  }, [picked]);

  const toggle = (a: string): void => setPicked((p) => (p.includes(a) ? p.filter((x) => x !== a) : p.length >= MAX ? p : [...p, a]));
  const limitBase = (): string => {
    try { return toBaseUnits(limit.trim() || '0'); } catch (err) { console.debug('spend limit not a number yet', err); return '0'; }
  };
  const run = hist?.running ?? hist?.run ?? null;
  const rows = useMemo(() => {
    const list = (run?.results ?? []).filter((r) => filter === 'ALL' || r.verdict === filter);
    return sort === 'speed' ? [...list].sort((a, b) => (b.mbps ?? -1) - (a.mbps ?? -1)) : list;
  }, [run, filter, sort]);
  const prevRun = hist && run ? hist.runs.find((r) => r.id < run.id) : undefined;

  return (
    <div>
      <PageHeader title="Node test" subtitle="A real session on each server you pick, one at a time: connect time, exit address, DNS and speed. Test deposits are closed afterwards." />
      {snap.session && <Banner kind="info">Disconnect first: the VPN service runs one session at a time, so testing waits until you are off the VPN.</Banner>}

      <Section
        title={<>Servers to test <span className="num text-meta text-fg-muted">{picked.length}/{MAX}</span></>}
        right={<>
          <button className="btn-ghost btn-sm" onClick={() => setPicked(online.slice(0, MAX).map((n) => n.address))} disabled={busy}>All online</button>
          <button className="btn-ghost btn-sm" onClick={() => setPicked([])} disabled={busy || !picked.length}>Clear</button>
        </>}
      >
        <div className="card overflow-hidden p-0">
          {online.length > 0 && (
            <div className={`${PICK_COLS} h-8 border-b border-line px-4 text-label uppercase text-fg-muted`} aria-hidden>
              <span /><span /><span>Country</span><span>Protocols</span><span>Server</span><span className="text-right">Response</span>
            </div>
          )}
          <div className="max-h-72 overflow-y-auto">
            {!online.length ? <div className="empty-line">No servers answered yet. Open Servers to check them.</div> : online.map((n) => (
              <label key={n.address} className={`${PICK_COLS} h-12 cursor-pointer border-b border-line px-4 text-sm last:border-0 hover:bg-bg-hover`}>
                <input type="checkbox" checked={picked.includes(n.address)} onChange={() => toggle(n.address)} disabled={busy} />
                <Flag code={n.countryCode} />
                <span className="truncate">{n.country}</span>
                <span className="flex min-w-0 items-center gap-1 text-fg-dim"><ProtocolList names={n.protocolNames} /></span>
                <span className="mono truncate text-fg-muted">{short(n.address)}</span>
                <span className="num text-right text-meta text-fg-muted">{n.probe?.latencyMs ?? '?'} ms</span>
              </label>
            ))}
          </div>
          {/* Footer bar of the list: what it can lock, your limit, the run button. */}
          <div className="flex flex-wrap items-end gap-6 border-t border-line bg-bg-raised/40 px-4 py-3">
            <div>
              <div className="label">Most it can lock in deposits</div>
              <div className="num flex h-10 items-center font-display text-value">{plan ? plan.estimateText : '—'}</div>
              {planError && <p className="text-sm text-bad" role="alert" data-plan-error>{planError}</p>}
            </div>
            <label className="block">
              <span className="label">Your spend limit (tDVPN)</span>
              <input className="input num w-36" value={limit} onChange={(e) => setLimit(e.target.value)} disabled={busy} inputMode="decimal" />
            </label>
            <div className="ml-auto flex gap-2">
              {busy ? (
                <button className="btn-danger" onClick={() => void call(window.api.IPC.NODE_TEST_STOP)}>Stop</button>
              ) : (
                <button className="btn-primary" disabled={!plan || !!snap.session || BigInt(limitBase()) < BigInt(plan.estimate)} onClick={() => setConfirm(plan)}>Run test</button>
              )}
            </div>
            {plan && !busy && BigInt(limitBase()) < BigInt(plan.estimate) && <div className="w-full text-meta text-warn">The limit is below what these servers can lock; raise it or pick fewer.</div>}
          </div>
        </div>
      </Section>

      {progress && (
        <div className="card mb-6" aria-live="polite">
          <div className="mb-2 flex justify-between text-sm"><span>Server {Math.min(progress.index + 1, progress.total)} of {progress.total}{progress.node ? ` · ${short(progress.node)}` : ''}</span><span className="num text-fg-muted">{progress.done} done</span></div>
          <div className="mb-2 h-1.5 overflow-hidden rounded bg-bg-raised"><div className="h-full bg-sol transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
          <div className="text-sm text-fg-dim">{progress.step}</div>
        </div>
      )}

      {run && (
        <>
          <StatStrip>
            <StatCell label="Fast" value={run.results.filter((r) => r.verdict === 'FAST').length} />
            <StatCell label="Slow" value={run.results.filter((r) => r.verdict === 'SLOW').length} />
            <StatCell label="Failed" value={run.results.filter((r) => r.verdict === 'FAIL').length} />
            <StatCell label="Without VPN" value={run.baselineMbps ? `${run.baselineMbps} Mbps` : '—'} hint={when(run.startedAt)} />
          </StatStrip>
          <div className="mb-3 flex items-center gap-2">
            {(['ALL', 'FAST', 'SLOW', 'FAIL'] as const).map((v) => <button key={v} className={`tab ${filter === v ? 'tab-active' : ''}`} onClick={() => setFilter(v)}>{v === 'ALL' ? 'All' : v}</button>)}
            <select className="input ml-auto w-40" value={sort} onChange={(e) => setSort(e.target.value as 'order' | 'speed')} aria-label="Sort"><option value="order">Test order</option><option value="speed">Fastest first</option></select>
            <button className="btn-ghost" onClick={() => void call(window.api.IPC.COPY, JSON.stringify(run, null, 2)).then(() => useApp.getState().toast('success', 'Run copied as JSON.'))}>Copy JSON</button>
          </div>
          <div className="card mb-6 overflow-hidden p-0">
            {!rows.length ? <div className="empty-line">Nothing to show for this filter.</div> : rows.map((r) => (
              <div key={r.node + r.startedAt} className="border-b border-line last:border-0">
                <button className="grid min-h-12 w-full grid-cols-[72px_minmax(0,140px)_minmax(0,140px)_minmax(0,140px)_minmax(0,1fr)] items-center gap-3 px-4 py-2 text-left text-sm hover:bg-bg-hover" onClick={() => setOpen(open === r.node ? null : r.node)} aria-expanded={open === r.node}>
                  <span className={`text-label font-semibold uppercase ${VERDICT_CLASS[r.verdict]}`}>{r.verdict}</span>
                  <span className="truncate">{r.country || '—'}</span>
                  <span className="text-fg-dim">{r.service ? <ProtocolTag protocol={r.service} /> : '—'}</span>
                  <span className="mono truncate text-fg-muted">{short(r.node)}</span>
                  <span className="truncate text-right text-meta text-fg-dim">{r.reason}</span>
                </button>
                {open === r.node && (
                  <div className="space-y-1 bg-bg-raised/40 px-4 pb-3 pt-1 text-meta text-fg-dim">
                    {r.checks.map((c) => <div key={c.name}><span className={c.ok ? 'text-ok' : 'text-bad'}>{c.ok ? '✓' : '✗'}</span> {c.name}: {c.detail}</div>)}
                    {r.error && <div className="text-bad">Error: {r.error}</div>}
                    <div>Server <CopyAddr text={r.node} /> · paid {r.basis === 'per_hour' ? 'per hour' : 'per GB'}{r.channel ? <> · deposit <CopyAddr text={r.channel} /></> : ''} · took {Math.round((r.endedAt - r.startedAt) / 1000)} s</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <Section title="Past runs">
        <div className={hist?.runs.length ? 'card overflow-hidden p-0' : ''}>
          {!hist?.runs.length ? <div className="empty-box">No test runs yet.</div> : hist.runs.map((r) => (
            <button key={r.id} className={`flex h-12 w-full items-center gap-4 border-b border-line px-4 text-left text-sm last:border-0 hover:bg-bg-hover ${run?.id === r.id ? 'bg-sol-soft' : ''}`} onClick={() => load(r.id)}>
              <span className="num w-36">{when(r.startedAt)}</span>
              <span className="num text-ok">FAST {r.fast}</span><span className="num text-warn">SLOW {r.slow}</span><span className="num text-bad">FAIL {r.fail}</span>
              <span className="num ml-auto text-meta text-fg-muted">{r.done}/{r.total}{r.stopped ? ' · stopped' : ''}</span>
            </button>
          ))}
        </div>
        {prevRun && <div className="mt-2 text-meta text-fg-muted">Compare: <button className="underline" onClick={() => load(prevRun.id)}>open the run before ({when(prevRun.startedAt)})</button></div>}
      </Section>

      {confirm && (
        <ConfirmModal
          title={`Test ${confirm.nodes} server${confirm.nodes === 1 ? '' : 's'}?`}
          lines={[
            `One real session on each server, one at a time. Up to ${confirm.estimateText} is locked in deposits; the unused part comes back when they close.`,
            'Per-hour deposits close right after the run; a per-GB one takes 2 hours (Activity → Refunds).',
            'Your internet goes through each server for about a minute while it is tested.',
          ]}
          confirmLabel="Run test"
          onConfirm={async () => { await call(window.api.IPC.NODE_TEST_RUN, { nodes: picked, maxSpend: limitBase(), confirmed: true }); setBusy(true); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
