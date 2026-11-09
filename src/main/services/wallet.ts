// ─── Wallet actions (F2.4–F2.6, F3) ───
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import type { Result, WalletStatus } from '../../shared/types';
import { readWalletStatus, lowFundsWarnings } from '../../core/app/wallet-status';
import { planDeviceSetup, runDeviceSetup, revokeDevice, type SetupPlan } from '../../core/app/device-setup';
import { readSettlements } from './settlement';
import { signAndSend } from '../../core/app/signer';
import { ata } from '../../core/chain/program';
import { MINT, TOKEN_DECIMALS } from '../../core/chain/idl';
import { toBaseUnits, toLamports } from '../../core/chain/amounts';
import { describeInstructionError } from '../../core/chain/errors';
import { isWalletAddress } from '../../core/wallet/keys';
import { ownerAddress, ownerSigner } from '../wallet/vault';
import { daemonInfo, startServiceIfStopped } from '../daemon/manager';
import { isAndroid } from '../platform/android-bridge';
import { patch, snapshot, toast } from '../app-state';
import { log } from '../logger';

export async function refreshWallet(): Promise<WalletStatus | null> {
  const owner = ownerAddress();
  if (!owner) { patch({ wallet: null, hasWallet: false, owner: null }); return null; }
  if (!snapshot().hasWallet) patch({ hasWallet: true, owner });
  try {
    const w = await readWalletStatus(owner, daemonInfo().device);
    patch({ wallet: w, hasWallet: true, owner, signerKind: 'in-app' });
    warnLowFunds(w);
    return w;
  } catch (err) {
    log.warn('wallet refresh failed', { err: (err as Error).message });
    return null;
  }
}

const raised = new Set<string>();
/** Toast (and notify, when hidden) once when a balance first drops below its floor. */
function warnLowFunds(w: WalletStatus): void {
  const now = lowFundsWarnings(w);
  for (const x of now) if (!raised.has(x.key)) { raised.add(x.key); toast('warn', x.message); }
  for (const k of [...raised]) if (!now.some((x) => x.key === k)) raised.delete(k);
}

function errText(err: unknown): string {
  return describeInstructionError(err) ?? (err as Error).message;
}

/** `refresh`: read the balances again first (the setup screen's "Check again" after funding). */
export async function deviceSetupPlan(allowanceTdvpn: string, refresh = false): Promise<Result<{ steps: string[]; topUpLamports: number; approveTo: string | null }>> {
  const owner = ownerAddress();
  const device = daemonInfo().device;
  // Name the exact missing step: on a fresh machine "set up the service first" sent CLI users in
  // a loop (daemon install asks for device setup, which needs the device key from daemon init).
  if (!owner) return { ok: false, error: 'Create or import a wallet first (wallet create / wallet import).' };
  if (!device) return { ok: false, error: `${isAndroid() ? 'This phone' : 'This computer'} has no device key yet. Create it on the Welcome screen first.` };
  if (refresh) await refreshWallet();
  const p: SetupPlan = await planDeviceSetup(owner, device, toBaseUnits(allowanceTdvpn));
  return { ok: true, data: { steps: p.steps, topUpLamports: p.topUpLamports, approveTo: p.approveTo } };
}

export const SERVICE_NOT_STARTED = 'Permission saved, but the VPN service did not start. Start it with one admin prompt: devnet-dvpn daemon install --yes';

export async function deviceSetup(allowanceTdvpn: string): Promise<Result<string | null>> {
  const device = daemonInfo().device;
  if (!device) return { ok: false, error: 'The VPN service has no device key yet.' };
  try {
    const r = await runDeviceSetup(ownerSigner(), device, toBaseUnits(allowanceTdvpn));
    await refreshWallet();
    // The service will not start without this permission; start it now that it exists.
    const svc = await startServiceIfStopped();
    log.info('service after device setup', { svc });
    if (svc === 'no-right' || svc === 'failed') toast('warn', SERVICE_NOT_STARTED);
    return { ok: true, data: r.signature };
  } catch (err) {
    log.error('device setup failed', { err: errText(err) });
    return { ok: false, error: errText(err), code: 'device-setup-failed' };
  }
}

/** Remove this device's spending permission (F3.4). Blocked while any of its deposits is still on chain. */
export async function revokeDeviceAccess(): Promise<Result<string>> {
  const device = daemonInfo().device;
  if (!device) return { ok: false, error: 'No device is set up.', code: 'no-device' };
  try {
    const live = snapshot().session ? 1 : (await readSettlements()).filter((s) => s.status === 'in-use').length;
    const sig = await revokeDevice(ownerSigner(), device, live);
    await refreshWallet();
    return { ok: true, data: sig };
  } catch (err) {
    return { ok: false, error: errText(err), code: 'revoke-failed' };
  }
}

/**
 * Remove ANOTHER device's spending permission (gap #95): a computer that is gone and whose key is
 * lost. The owner signs; the device itself is not needed. Its deposits then settle with
 * `settle run --device`. A session it may still be running elsewhere cannot be seen from here,
 * which is why the CLI asks the user to confirm the device is no longer in use.
 */
export async function revokeOtherDevice(other: string): Promise<Result<string>> {
  if (!isWalletAddress(other)) return { ok: false, error: 'That is not a device address.', code: 'bad-device' };
  if (other === daemonInfo().device) return { ok: false, error: `That is ${isAndroid() ? 'this phone' : 'this computer'}'s device: run device revoke without --device.`, code: 'own-device' };
  try {
    const sig = await revokeDevice(ownerSigner(), other, 0);
    await refreshWallet();
    return { ok: true, data: sig };
  } catch (err) {
    return { ok: false, error: errText(err), code: 'revoke-failed' };
  }
}

export function transferInstructions(from: PublicKey, to: PublicKey, tdvpnBase: bigint, lamports: bigint): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
  if (tdvpnBase > 0n) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, ata(to), to, MINT, TOKEN_2022_PROGRAM_ID));
    ixs.push(createTransferCheckedInstruction(ata(from), MINT, ata(to), from, tdvpnBase, TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
  }
  return ixs;
}

/** Send tDVPN and/or SOL (F2.5). Amounts are display strings. */
export async function send(req: { to: string; tdvpn?: string; sol?: string; confirmed: true }): Promise<Result<string>> {
  if (req.confirmed !== true) return { ok: false, error: 'Confirm the transfer first.', code: 'not-confirmed' };
  if (!isWalletAddress(req.to)) return { ok: false, error: 'That is not a Solana wallet address.', code: 'invalid-address' };
  const base = BigInt(req.tdvpn ? toBaseUnits(req.tdvpn) : '0');
  const lamports = req.sol ? toLamports(req.sol) : 0n;
  if (base === 0n && lamports === 0n) return { ok: false, error: 'Enter an amount.', code: 'invalid-amount' };
  try {
    const s = ownerSigner();
    const r = await signAndSend(s, transferInstructions(s.publicKey, new PublicKey(req.to), base, lamports), 'transfer');
    await refreshWallet();
    return { ok: true, data: r.signature };
  } catch (err) {
    return { ok: false, error: errText(err), code: 'send-failed' };
  }
}
