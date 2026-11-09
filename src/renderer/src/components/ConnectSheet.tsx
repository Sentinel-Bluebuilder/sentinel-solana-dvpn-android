// ─── Connect sheet (F8, F9): basis + amount → exact cost → confirm ───
// The escrow shown is what gets locked; unused escrow is refundable after close.
// Nothing is spent until the user presses Connect here.
import { useEffect, useState } from 'react';
import { call, useApp } from '../lib/store';
import { costPreview, priceLabel, GB_OPTIONS, HOUR_OPTIONS, WIRE_OVERHEAD_NOTE, tdvpn, formatTdvpn } from '../../../shared/format';
import { Flag } from './ui';
import type { NodeView, Basis, AppSnapshot } from '../../../shared/types';

export function ConnectSheet({ node, snap, onClose, subscription }: {
  node: NodeView; snap: AppSnapshot; onClose: () => void;
  subscription?: { provider: string; subscription: string };
}) {
  const settings = useApp((s) => s.settings);
  const hasGb = BigInt(node.pricePerGb || '0') > 0n;
  const hasHour = BigInt(node.pricePerHour || '0') > 0n;
  const [basis, setBasis] = useState<Basis>(settings?.defaultBasis === 'per_hour' && hasHour ? 'per_hour' : hasGb ? 'per_gb' : 'per_hour');
  const [units, setUnits] = useState<number>(basis === 'per_hour' ? settings?.defaultHours ?? 1 : settings?.defaultGb ?? 1);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setUnits(basis === 'per_hour' ? settings?.defaultHours ?? 1 : settings?.defaultGb ?? 1); }, [basis, settings]);

  const preview = costPreview(node, basis, units);
  const w = snap.wallet;
  const funds = w ? BigInt(w.ownerTdvpn) + BigInt(w.userBalance) : 0n;
  const blocker = subscription ? null
    : !preview.available ? 'This server does not offer this pricing.'
      : !w ? 'Wallet balances are still loading.'
        : funds < BigInt(preview.escrow) ? `You need ${preview.escrowText}; your wallet has ${formatTdvpn(funds)} tDVPN.`
          : w.grant && BigInt(w.grant.allowance) < BigInt(preview.escrow) ? `This is above the device spending limit (${tdvpn(w.grant.allowance)} tDVPN). Raise it in Wallet.`
            : BigInt(w.delegated) < BigInt(preview.escrow) ? 'The token permission is below this amount. Re-run device setup in Wallet.'
              : w.deviceLamports < 5_000_000 ? 'The device needs SOL for fees. Top it up in Wallet.'
                : null;

  const opts = basis === 'per_hour' ? HOUR_OPTIONS : GB_OPTIONS;
  // Connected elsewhere: the button switches (new server checked first, then the old session stops).
  const switching = snap.conn.phase === 'connected' && !!snap.session && snap.session.node !== node.address;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Connect">
      <div className="card w-full max-w-md rounded-xl p-6">
        <div className="mb-4 flex items-center gap-3">
          <Flag code={node.countryCode} size={24} />
          <div className="min-w-0">
            <div className="font-display text-section">{node.country || 'Unknown country'}{node.probe?.city ? ` · ${node.probe.city}` : ''} <span className="font-sans text-meta text-fg-muted" title="Self-declared by the operator">reported location</span></div>
            <div className="mono truncate text-fg-muted">{node.address}</div>
          </div>
        </div>
        {subscription ? (
          <p className="mb-4 text-sm text-fg-dim">Connect with your plan subscription. Usage is covered by the plan; nothing new is locked.</p>
        ) : (
          <>
            <div className="mb-3 flex gap-2" role="radiogroup" aria-label="Pricing">
              <button role="radio" aria-checked={basis === 'per_gb'} disabled={!hasGb} className={basis === 'per_gb' ? 'btn-primary' : 'btn-ghost'} onClick={() => setBasis('per_gb')}>Per GB · {priceLabel(node.pricePerGb, 'per_gb')}</button>
              <button role="radio" aria-checked={basis === 'per_hour'} disabled={!hasHour} className={basis === 'per_hour' ? 'btn-primary' : 'btn-ghost'} onClick={() => setBasis('per_hour')}>Per hour · {priceLabel(node.pricePerHour, 'per_hour')}</button>
            </div>
            <div className="label">{basis === 'per_hour' ? 'Hours' : 'Gigabytes'}</div>
            <div className="mb-4 flex flex-wrap gap-2">
              {opts.map((o) => <button key={o} className={o === units ? 'btn-primary num min-w-12' : 'btn-ghost num min-w-12'} onClick={() => setUnits(o)}>{o}</button>)}
            </div>
            <div className="mb-4 rounded border border-line bg-bg-input p-4 text-sm">
              <div className="flex justify-between"><span className="text-fg-dim">Locked now</span><span className="font-semibold tabular-nums">{preview.escrowText}</span></div>
              <div className="mt-1 text-meta text-fg-muted">The node is paid only for what you use; the rest comes back to your wallet after you disconnect (about 2 hours for per-GB deposits). {preview.feeText}. {basis === 'per_gb' ? WIRE_OVERHEAD_NOTE : ''}</div>
            </div>
          </>
        )}
        {switching && <p className="mb-3 text-sm text-fg-dim">You will leave your current server; its unused deposit is refunded after settlement.</p>}
        {blocker && <p className="mb-3 text-sm text-bad" role="alert">{blocker}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button data-connect-confirm className="btn-primary" disabled={!!blocker || busy || (!snap.conn.canConnect && !switching)} onClick={async () => {
            setBusy(true);
            onClose();
            try {
              await call(window.api.IPC.CONNECT, { node: node.address, basis, units, confirmed: true, subscription, switch: switching }, { quiet: true });
            } catch (err) {
              // A stop the user asked for is a note, not an error (Home keeps the text and the button).
              const e = err as Error & { code?: string };
              useApp.getState().toast(e.code === 'cancelled' ? 'info' : 'error', e.message);
              console.warn('connect failed', e.code, e.message);
            }
          }}>
            {(switching ? 'Switch' : 'Connect') + (subscription ? '' : ` · lock ${preview.escrowText}`)}
          </button>
        </div>
      </div>
    </div>
  );
}
