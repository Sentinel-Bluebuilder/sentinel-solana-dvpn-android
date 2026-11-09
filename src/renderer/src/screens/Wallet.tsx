// ─── Wallet (F2, F3): balances, receive, send, device permission, withdraw ───
import { useEffect, useState } from 'react';
import { call, useApp } from '../lib/store';
import { byPlatform, thisDevice } from '../lib/platform';
import { Banner, ConfirmModal, Copy, PageHeader, Section, StatCell, StatStrip } from '../components/ui';
import { tdvpn, formatTdvpn, sol, short } from '../../../shared/format';
import type { AppSnapshot, PendingSettlement } from '../../../shared/types';
import { sendToast, settleToast, withdrawToast } from '../../../shared/money-toast';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function Wallet({ snap }: { snap: AppSnapshot }) {
  const w = snap.wallet;
  // Same rule as revokeDevice (c8269e8): only a deposit in use blocks removal; settling never needs the permission.
  const inUse = !!snap.session || snap.settlements.some((x) => x.status === 'in-use');
  const [qr, setQr] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [asset, setAsset] = useState<'tdvpn' | 'sol'>('tdvpn');
  const [modal, setModal] = useState<null | 'send' | 'withdraw' | 'device' | 'logout' | 'revoke' | 'revoke-other' | 'settle-other'>(null);
  // Another device of this wallet (gap #95): a computer that is gone. Remove its permission, then settle its deposits.
  const [other, setOther] = useState('');
  const [otherList, setOtherList] = useState<PendingSettlement[] | null>(null);
  const [otherBusy, setOtherBusy] = useState(false);
  // Set when the device still holds its permission: its deposits can't be settled until it's removed.
  const [otherActive, setOtherActive] = useState('');
  const [allowance, setAllowance] = useState(useApp.getState().settings?.allowanceTdvpn ?? '50');
  const [devicePlan, setDevicePlan] = useState<string[]>([]);

  useEffect(() => { call<string | null>(window.api.IPC.WALLET_QR).then(setQr, () => setQr(null)); }, [snap.owner]);

  const sendBlocker = !ADDR.test(to.trim()) ? 'Enter a valid Solana address.' : !(Number(amt) > 0) ? 'Enter an amount.' : to.trim() === snap.owner ? 'That is your own address.' : null;
  const otherAddr = other.trim();
  const otherBlocker = !ADDR.test(otherAddr) ? 'Enter the other device’s address.' : otherAddr === w?.device ? `That is ${thisDevice()}’s device: use Remove permission above.` : otherAddr === snap.owner ? 'That is your wallet address, not a device.' : null;
  const otherDue = (otherList ?? []).filter((x) => x.status === 'open' || x.status === 'ready');
  const otherRefund = (otherList ?? []).reduce((s, x) => s + BigInt(x.refundable || '0'), 0n);
  const loadOther = async (): Promise<void> => {
    setOtherBusy(true);
    setOtherActive('');
    try { setOtherList(await call<PendingSettlement[]>(window.api.IPC.SETTLE_LIST, { device: otherAddr }, { quiet: true })); } catch (err) {
      setOtherList(null);
      const e = err as Error & { code?: string };
      // Still allowed to spend: say so in the card (the next step is right there), not as an error toast.
      if (e.code === 'device-active') setOtherActive(e.message);
      else { useApp.getState().toast('error', e.message || 'Could not read that device’s deposits.'); console.warn('other device deposits', err); }
    } finally { setOtherBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Wallet" subtitle={byPlatform('Your keys stay on this computer, encrypted by Windows.', 'Your keys stay on this phone, encrypted by the Android Keystore.')} />
      <StatStrip>
        <StatCell label="tDVPN" value={formatTdvpn(w?.ownerTdvpn ?? '0')} />
        <StatCell label="SOL (fees)" value={sol(w?.ownerLamports ?? 0)} />
        <StatCell label="Ready to withdraw" value={formatTdvpn(w?.userBalance ?? '0')} hint={w && BigInt(w.userBalance) > 0n ? <button className="text-accent-ink underline" onClick={() => setModal('withdraw')}>Withdraw to wallet</button> : 'Comes back from closed deposits'} />
      </StatStrip>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {/* Receive: QR left, address and actions right, one row. */}
        <Section title="Receive" className="mb-0">
          <div className="card flex items-start gap-4">
            {qr && <img src={qr} alt="Wallet address QR code" className="h-32 w-32 shrink-0 rounded bg-white p-1" />}
            <div className="min-w-0 flex-1">
              <div className="label">Your address</div>
              <div className="mono mb-4 break-all">{snap.owner}</div>
              <div className="flex flex-wrap items-center gap-2">
                {snap.owner && <Copy text={snap.owner} label="Copy address" />}
                <button className="btn-ghost btn-sm" onClick={() => void call(window.api.IPC.OPEN_EXTERNAL, 'https://faucet.solana.com/')}>Devnet SOL faucet</button>
              </div>
            </div>
          </div>
        </Section>
        <Section title="Send" className="mb-0">
          <div className="card flex flex-col gap-3">
            <input className="input mono" placeholder="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient address" />
            <div className="flex gap-2">
              <input className="input num" inputMode="decimal" placeholder="Amount" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Amount" />
              <select className="input w-28" value={asset} onChange={(e) => setAsset(e.target.value as 'tdvpn' | 'sol')} aria-label="Asset"><option value="tdvpn">tDVPN</option><option value="sol">SOL</option></select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-meta text-bad">{to && sendBlocker ? sendBlocker : ''}</p>
              <button className="btn-primary" disabled={!!sendBlocker} onClick={() => setModal('send')}>Review</button>
            </div>
          </div>
        </Section>
      </div>

      <Section title="This device">
        {!w?.ready && <Banner kind="warn">This device can&apos;t pay nodes yet. Run device setup below.</Banner>}
        <div className="card overflow-hidden p-0">
          {/* One key-value table: label left, value right, action at the row end. */}
          <dl className="text-sm">
            <div className="flex h-12 items-center gap-4 border-b border-line px-4"><dt className="flex-1 text-fg-dim">Device</dt><dd className="mono">{short(w?.device)}</dd><dd className="flex w-20 justify-end">{w?.device && <Copy text={w.device} />}</dd></div>
            <div className="flex h-12 items-center gap-4 border-b border-line px-4"><dt className="flex-1 text-fg-dim">Spending limit</dt><dd className="num">{w?.grant ? `${formatTdvpn(w.grant.allowance)} tDVPN` : 'none'}</dd><dd className="w-20" /></div>
            <div className="flex h-12 items-center gap-4 border-b border-line px-4"><dt className="flex-1 text-fg-dim">Token permission</dt><dd className="num">{formatTdvpn(w?.delegated ?? '0')} tDVPN</dd><dd className="w-20" /></div>
            <div className="flex h-12 items-center gap-4 border-b border-line px-4"><dt className="flex-1 text-fg-dim">Device SOL</dt><dd className="num">{sol(w?.deviceLamports ?? 0)}</dd><dd className="w-20" /></div>
          </dl>
          <div className="flex flex-wrap items-end gap-2 bg-bg-raised/40 px-4 py-3">
            <div>
              <label className="label" htmlFor="lim">New limit (tDVPN)</label>
              <input id="lim" className="input num w-36" inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <button className="btn-ghost" onClick={async () => {
              try {
                const plan = await call<{ steps: string[] }>(window.api.IPC.DEVICE_SETUP_PLAN, { allowance });
                if (!plan.steps.length) { useApp.getState().toast('info', 'The device is already set up with this limit.'); return; }
                setDevicePlan(plan.steps); setModal('device');
              } catch (err) { console.warn('device plan failed', err); }
            }}>Update device setup</button>
            <button className="btn-ghost ml-auto text-bad" disabled={!w?.grant || inUse} title={inUse ? 'Disconnect first: a deposit is in use right now.' : undefined} onClick={() => setModal('revoke')}>Remove permission</button>
            {w?.grant && !inUse && snap.settlements.length > 0 && <p className="w-full text-meta text-fg-muted">Removing the permission is safe: this device&apos;s {snap.settlements.length} deposit(s) still settle and refund to your wallet.</p>}
          </div>
        </div>
      </Section>

      {/* Another computer of this wallet that is gone (gap #95): its permission and deposits stay on chain until removed here. */}
      <Section title="Other devices">
        <div className="card flex flex-col gap-3" data-other-device>
          <p className="text-sm text-fg-dim">{byPlatform('A computer', 'A phone or computer')} you no longer use can still spend from this wallet. Paste its device address to remove its permission, then settle its deposits back here.</p>
          <input className="input mono" placeholder="Other device address" value={other} onChange={(e) => { setOther(e.target.value); setOtherList(null); setOtherActive(''); }} aria-label="Other device address" />
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto min-w-0 text-meta text-bad">{other && otherBlocker ? otherBlocker : ''}</p>
            <button className="btn-ghost" disabled={!!otherBlocker || otherBusy} onClick={() => void loadOther()}>Check deposits</button>
            <button className="btn-ghost text-bad" disabled={!!otherBlocker || otherBusy} onClick={() => setModal('revoke-other')}>Remove permission…</button>
          </div>
          {otherActive && <p className="border-t border-line pt-3 text-sm" data-other-active>{otherActive}</p>}
          {otherList && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3" data-other-deposits={otherList.length}>
              <span className="min-w-0 flex-1 text-sm">
                {otherList.length ? `${otherList.length} deposit(s), ${formatTdvpn(otherRefund.toString())} tDVPN refundable; ${otherDue.length} can be settled now.` : 'This device has no deposits left.'}
              </span>
              {otherDue.length > 0 && <button className="btn-primary shrink-0" onClick={() => setModal('settle-other')}>Settle its deposits</button>}
            </div>
          )}
        </div>
      </Section>

      {/* Leaving the wallet sits last, quiet, like account sign-out in leading apps. */}
      <div className="card mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="min-w-0 text-sm text-fg-dim">Sign out removes this wallet from the app on {thisDevice()}.</span>
        <button className="btn-ghost shrink-0 text-bad" onClick={() => setModal('logout')}>Sign out of this wallet</button>
      </div>

      {modal === 'send' && (
        <ConfirmModal title="Send" lines={[`Send ${amt} ${asset === 'sol' ? 'SOL' : 'tDVPN'} to ${to.trim()}.`, 'Transfers can’t be reversed.', 'Network: Solana devnet (test tokens).']} confirmLabel="Send"
          onConfirm={async () => { await call(window.api.IPC.SEND, { to: to.trim(), [asset]: amt, confirmed: true }); useApp.getState().toast('success', sendToast(amt, asset, to.trim())); setTo(''); setAmt(''); }} onClose={() => setModal(null)} />
      )}
      {modal === 'withdraw' && (
        <ConfirmModal title="Withdraw refunds" lines={[`Move ${tdvpn(w?.userBalance ?? '0')} tDVPN of refunds to your wallet.`]} confirmLabel="Withdraw"
          onConfirm={async () => { const amount = tdvpn(w?.userBalance ?? '0'); await call(window.api.IPC.WITHDRAW, { confirmed: true }); useApp.getState().toast('success', withdrawToast(amount)); }} onClose={() => setModal(null)} />
      )}
      {modal === 'device' && (
        <ConfirmModal title="Update device setup" lines={[...devicePlan, 'Network: Solana devnet (test tokens).']} confirmLabel="Sign"
          onConfirm={async () => { await call(window.api.IPC.DEVICE_SETUP, { allowance, confirmed: true }); }} onClose={() => setModal(null)} />
      )}
      {modal === 'revoke' && (
        <ConfirmModal title="Remove device permission" danger lines={['This device can no longer pay nodes until you set it up again.', 'The account rent comes back to your wallet.', 'Network: Solana devnet (test tokens).']} confirmLabel="Remove"
          onConfirm={async () => { await call(window.api.IPC.DEVICE_REVOKE, { confirmed: true }); }} onClose={() => setModal(null)} />
      )}
      {modal === 'revoke-other' && (
        <ConfirmModal title="Remove another device" danger lines={[`Device ${otherAddr}.`, `Do this only for a ${byPlatform('computer', 'phone or computer')} you no longer use: it can no longer pay for VPN sessions.`, 'Its deposits can then be settled here.', 'Network: Solana devnet (test tokens).']} confirmLabel="Remove"
          onConfirm={async () => { await call(window.api.IPC.DEVICE_REVOKE, { device: otherAddr, confirmed: true }); await loadOther(); }} onClose={() => setModal(null)} />
      )}
      {modal === 'settle-other' && (
        <ConfirmModal title="Settle its deposits" lines={[`Settle ${otherDue.length} deposit(s) of device ${short(otherAddr)} now.`, 'Refunds come back to this wallet; a deposit that is still in its close wait finishes later.', 'Network: Solana devnet (test tokens).']} confirmLabel="Settle"
          onConfirm={async () => { const sigs = await call<string[]>(window.api.IPC.SETTLE_RUN, { device: otherAddr, confirmed: true }); useApp.getState().toast('success', settleToast(sigs)); await loadOther(); }} onClose={() => setModal(null)} />
      )}
      {modal === 'logout' && (
        <ConfirmModal title="Sign out" danger lines={[`Removes the encrypted key from ${thisDevice()}.`, 'You need your recovery phrase or key file to sign in again. Funds stay on chain.']} confirmLabel="Sign out"
          onConfirm={async () => { await call(window.api.IPC.WALLET_LOGOUT); }} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
