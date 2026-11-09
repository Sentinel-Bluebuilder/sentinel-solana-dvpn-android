// ─── Server browser (F6, F7) ───
// Listed ≠ online: only nodes whose signed metadata verified are connectable.
// Row ORDER is frozen until the user presses "Re-sort" so probe results never
// make rows jump under the cursor; row DATA updates live.
import { useEffect, useMemo, useState } from 'react';
import { call, useApp } from '../lib/store';
import { Copy, Flag, PageHeader, Skeleton } from '../components/ui';
import { ProtocolList } from '../components/ProtocolMark';
import { ConnectSheet } from '../components/ConnectSheet';
import { priceLabel, countryName } from '../../../shared/format';
import type { AppSnapshot, NodeView } from '../../../shared/types';
import type { Screen } from '../App';

type Sort = 'latency' | 'price_gb' | 'price_hour' | 'peers';
const PROTOCOLS = ['wireguard', 'v2ray', 'xray', 'openvpn', 'amneziawg', 'hysteria2'];
// Server rows: the Protocols column only where it fits (a 1366x768 screen at 150 % leaves ~630 px of
// page); narrower, the protocol marks sit under the address and the server name keeps its width.
const ROW_COLS = 'grid-cols-[24px_minmax(0,1fr)_136px_88px_88px] min-[1100px]:grid-cols-[24px_minmax(0,1fr)_160px_136px_88px_88px]';

// Expired listings are never probed (the node stopped renewing), so "no probe" means "checking" only for fresh ones.
function status(n: NodeView): { label: string; tone: string } {
  if (!n.probe) return n.listingFresh ? { label: 'Checking', tone: 'text-fg-muted' } : { label: 'Listing expired', tone: 'text-fg-muted' };
  if (n.probe.ok) return { label: `${n.probe.latencyMs ?? '?'} ms`, tone: 'text-ok' };
  return { label: n.probe.reachable ? 'Unverified' : 'Offline', tone: 'text-bad' };
}

function sortKey(n: NodeView, sort: Sort): number {
  const off = n.probe?.ok ? 0 : 1e15;
  if (sort === 'latency') return off + (n.probe?.latencyMs ?? 9e9);
  if (sort === 'price_gb') return off + (Number(n.pricePerGb) || 9e12);
  if (sort === 'price_hour') return off + (Number(n.pricePerHour) || 9e12);
  return off + (n.probe?.peers ?? 9e9);
}

export function Nodes({ snap }: { snap: AppSnapshot; go: (s: Screen) => void }) {
  const { nodes, probeProgress } = useApp();
  const [q, setQ] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [favOnly, setFavOnly] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { call<string[]>(window.api.IPC.RECENT_NODES, undefined, { quiet: true }).then(setRecent, () => setRecent([])); }, []);
  const [proto, setProto] = useState('');
  const [basis, setBasis] = useState<'' | 'per_gb' | 'per_hour'>('');
  const [sort, setSort] = useState<Sort>('latency');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<string | null>(null);
  const [sheet, setSheet] = useState<NodeView | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    call<NodeView[]>(window.api.IPC.NODES_LIST).then((list) => { if (list.length) useApp.getState().setNodes(list); }, (err) => console.warn('node list failed', err)).finally(() => setLoaded(true));
  }, []);

  const resort = (list = nodes): void => setOrder([...list].sort((a, b) => sortKey(a, sort) - sortKey(b, sort)).map((n) => n.address));
  // Re-sort when the set of nodes changes or the user changes the sort, never on probe updates.
  const membership = nodes.map((n) => n.address).sort().join(',');
  useEffect(() => { resort(); }, [membership, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const byAddr = useMemo(() => new Map(nodes.map((n) => [n.address, n])), [nodes]);
  const needle = q.trim().toLowerCase();
  const visible = order.map((a) => byAddr.get(a)).filter((n): n is NodeView => !!n).filter((n) =>
    (!onlineOnly || n.probe?.ok || (!n.probe && n.listingFresh && !!probeProgress))
    && (!favOnly || n.favourite)
    && (!recentOnly || recent.includes(n.address))
    && (!proto || n.protocolNames.includes(proto))
    && (!basis || BigInt((basis === 'per_gb' ? n.pricePerGb : n.pricePerHour) || '0') > 0n)
    && (!needle || [n.country, n.countryCode, n.probe?.city ?? '', n.address].some((f) => f.toLowerCase().includes(needle))));

  const groups = useMemo(() => {
    const m = new Map<string, NodeView[]>();
    for (const n of visible) m.set(n.countryCode || '??', [...(m.get(n.countryCode || '??') ?? []), n]);
    return [...m.entries()].sort((a, b) => countryName(a[0]).localeCompare(countryName(b[0])));
  }, [visible]);

  const onlineCount = nodes.filter((n) => n.probe?.ok).length;
  const searching = needle.length > 0;

  return (
    <div>
      <PageHeader
        title="Servers"
        subtitle={`${onlineCount} online of ${nodes.length} listed${probeProgress ? ` · checking ${probeProgress.done}/${probeProgress.total}` : ''}`}
        right={<><button className="btn-ghost" title="Rows stay still while servers are checked; this re-orders them by the current sort." onClick={() => resort()}>Re-sort</button><button className="btn-ghost" onClick={() => void call(window.api.IPC.NODES_REFRESH)}>Refresh</button></>}
      />
      {/* One toolbar row: search takes the free width, filters keep one height, toggles are chips. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="input min-w-[220px] flex-1" placeholder="Search country, city or address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search servers" />
        <select className="input w-40" value={proto} onChange={(e) => setProto(e.target.value)} aria-label="Protocol">
          <option value="">All protocols</option>
          {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input w-36" value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)} aria-label="Pricing">
          <option value="">Any pricing</option>
          <option value="per_gb">Pay per GB</option>
          <option value="per_hour">Pay per hour</option>
        </select>
        <select className="input w-44" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="latency">Fastest response</option>
          <option value="price_gb">Price per GB</option>
          <option value="price_hour">Price per hour</option>
          <option value="peers">Fewest users</option>
        </select>
        <label className={`toggle-chip ${onlineOnly ? 'toggle-chip-on' : ''}`}><input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} /> Online only</label>
        <label className={`toggle-chip ${favOnly ? 'toggle-chip-on' : ''}`}><input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} /> Favourites</label>
        <label className={`toggle-chip ${recentOnly ? 'toggle-chip-on' : ''}`}><input type="checkbox" checked={recentOnly} onChange={(e) => setRecentOnly(e.target.checked)} disabled={!recent.length} /> Recent</label>
      </div>

      {!loaded || (!nodes.length && probeProgress) ? <Skeleton rows={6} /> : !groups.length ? (
        <div className="empty-box">
          {!nodes.length ? 'No servers are listed on devnet right now.'
            : onlineOnly && !onlineCount ? <>No servers are online right now. <button className="text-accent-ink underline" onClick={() => setOnlineOnly(false)}>Show all {nodes.length} listed</button></>
              : 'No servers match these filters.'}
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map(([cc, list]) => {
            // Few countries: open them all, so the list is the page (no screen of collapsed rows).
            const isOpen = open[cc] ?? (searching || groups.length <= 3);
            const up = list.filter((n) => n.probe?.ok).length;
            return (
              <div key={cc} className="card overflow-hidden p-0">
                <button className="flex h-12 w-full items-center gap-3 px-4 text-left hover:bg-bg-hover" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [cc]: !isOpen })}>
                  <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 text-fg-muted transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
                  <Flag code={cc} />
                  <span className="font-medium">{countryName(cc)}</span>
                  <span className="num text-meta text-fg-muted">{up}/{list.length} online</span>
                  {/* Which protocols this country offers, before opening it (feature icons per country). */}
                  <span className="ml-auto flex items-center gap-1 text-fg-muted" data-country-protocols={cc}><ProtocolList names={[...new Set(list.flatMap((n) => n.protocolNames ?? []))]} compact /></span>
                </button>
                {isOpen && (
                  <div className={`grid h-8 ${ROW_COLS} items-center gap-4 border-t border-line px-4 text-label uppercase text-fg-muted`} aria-hidden>
                    <span /><span>Server</span><span className="hidden min-[1100px]:block">Protocols</span><span className="text-right">Price</span><span className="text-right">Response</span><span />
                  </div>
                )}
                {isOpen && list.map((n) => {
                  const st = status(n);
                  return (
                    <div key={n.address} className="border-t border-line">
                      <div className={`grid min-h-14 ${ROW_COLS} items-center gap-4 px-4 py-2`}>
                        <button className="text-lg leading-none text-warn" aria-label={n.favourite ? 'Remove favourite' : 'Add favourite'} onClick={() => void call(window.api.IPC.FAVOURITE_TOGGLE, n.address).then(() => call<NodeView[]>(window.api.IPC.NODES_LIST)).then((l) => useApp.setState({ nodes: l }))}>{n.favourite ? '★' : '☆'}</button>
                        <button className="min-w-0 text-left" onClick={() => setDetail(detail === n.address ? null : n.address)}>
                          <div className="truncate text-sm">{n.probe?.city || countryName(n.countryCode)}</div>
                          <div className="mono truncate text-fg-muted">{n.address}</div>
                          <div className="mt-1 flex items-center gap-1 text-fg-dim min-[1100px]:hidden"><ProtocolList names={n.protocolNames} compact /></div>
                        </button>
                        <div className="hidden min-w-0 items-center gap-1 text-fg-dim min-[1100px]:flex"><ProtocolList names={n.protocolNames} /></div>
                        <div className="num text-right text-meta text-fg-dim">{priceLabel(n.pricePerGb, 'per_gb')}<br />{priceLabel(n.pricePerHour, 'per_hour')}</div>
                        <div className={`num text-right text-meta ${st.tone}`}>{st.label}</div>
                        <button data-connect={n.address} className="btn-ghost btn-sm" disabled={!n.probe?.ok || (!snap.conn.canConnect && snap.conn.phase !== 'connected') || snap.session?.node === n.address} onClick={() => setSheet(n)}>Connect</button>
                      </div>
                      {detail === n.address && <NodeDetail n={n} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {sheet && <ConnectSheet node={sheet} snap={snap} onClose={() => setSheet(null)} />}
    </div>
  );
}

function NodeDetail({ n }: { n: NodeView }) {
  const p = n.probe;
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-4 py-0.5"><span className="text-fg-muted">{k}</span><span className="text-right">{v}</span></div>;
  const check = (v: boolean | null | undefined) => (v == null ? '—' : v ? '✓' : '✗');
  return (
    <div className="grid grid-cols-1 gap-x-8 bg-bg-input px-4 py-3 text-meta sm:grid-cols-2">
      <div>
        {row('Location', <span title="Self-declared by the operator; not verified">{countryName(n.countryCode)}{p?.city ? `, ${p.city}` : ''} <span className="text-fg-muted">(reported)</span></span>)}
        {row('Address', <span className="mono">{n.address} <Copy text={n.address} /></span>)}
        {row('Operator', <span className="mono">{n.owner}</span>)}
        {row('Protocols', <ProtocolList names={n.protocolNames} />)}
        {row('Users', p?.peers != null ? `${p.peers}${p.maxPeers ? ` / ${p.maxPeers}` : ''}` : '—')}
        {row('Bandwidth', p?.downloadMbps ? `${p.downloadMbps} ↓ / ${p.uploadMbps ?? '?'} ↑ Mbps` : '—')}
        {row('Version', p?.version ?? '—')}
      </div>
      <div>
        {row('Listed', n.listingFresh ? `yes, renews by ${new Date(n.expiresAt * 1000).toLocaleString()}` : 'listing stale')}
        {row('Signed by owner or allowed operator', check(p?.signerAuthorized))}
        {row('Signature valid', check(p?.signatureValid))}
        {row('Matches chain', check(p?.claimsMatch))}
        {row('TLS key pinned', check(p?.tlsPinMatch))}
        {p?.error && row('Problem', <span className="text-bad">{p.error}</span>)}
      </div>
    </div>
  );
}
