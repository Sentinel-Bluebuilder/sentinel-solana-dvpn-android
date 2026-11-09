// ─── Success copy for money actions (Q0310) ───
// Top up / Settle / Withdraw refunds / Send closed their dialog on success with nothing else: the
// person could not tell it worked. Browser-safe; the screens toast these after the call returns.

export function topUpToast(amountTdvpn: string): string {
  return `Topped up ${amountTdvpn} tDVPN.`;
}

/** `sigs`: the transactions the settlement run sent (none = nothing was ready). */
export function settleToast(sigs: unknown): string {
  const n = Array.isArray(sigs) ? sigs.length : 0;
  if (n === 0) return 'Nothing to settle right now. Deposits still in their close wait finish later.';
  return `Settlement sent: ${n} transaction${n === 1 ? '' : 's'}. Refunds reach your wallet as each deposit closes.`;
}

export function withdrawToast(amountTdvpn: string): string {
  return `Moved ${amountTdvpn} tDVPN of refunds to your wallet.`;
}

export function sendToast(amount: string, asset: 'sol' | 'tdvpn', to: string): string {
  return `Sent ${amount} ${asset === 'sol' ? 'SOL' : 'tDVPN'} to ${to.slice(0, 4)}…${to.slice(-4)}.`;
}
