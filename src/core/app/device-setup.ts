// ─── Device setup / allowance (F3) — one owner signature ───
// The device key lives in dvpnd and opens channels for the owner. It needs:
//   1. Token-2022 delegate = Config PDA on the owner ATA. The delegate amount is
//      ONE shared number for every device, and ApproveChecked SETS it — so we add
//      to what is already approved instead of overwriting another device's room.
//   2. a Grant (owner → device, every target, dvpnd's client permissions, no expiry) whose
//      allowance is the device's cumulative spend cap.
//   3. a little SOL: the device pays fees and the channel account rent.
// All three go in one transaction so onboarding is a single approval.
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import * as b from '../chain/builders';
import { tdvpn } from '../chain/amounts';
import { sol } from '../../shared/format';
import { readWalletStatus, type WalletStatus } from './wallet-status';
import { signAndSend, type OwnerSigner } from './signer';
import { DEVICE_SOL_MIN } from '../pricing/cost';
import { PERMS_CLIENT } from '../chain/idl';

export const DEVICE_SOL_TARGET = 50_000_000; // 0.05 SOL: fees + ~0.0022 SOL rent per open channel (returned on close), ~20 channels (F3)

/** What the owner keeps for its own fees when it tops up a device. */
export const OWNER_SOL_RESERVE = 2_000_000;

/**
 * Automatic device top-up before a connect (soak 2026-10-21: every small per-GB deposit holds
 * ~0.004 SOL of rent until it is settled ~2 h later, so a busy device ran dry after ~50
 * connects). Lamports to send so the device is back at DEVICE_SOL_TARGET; 0 when no top-up is
 * needed; null when the owner wallet cannot spare it.
 */
export function deviceTopUpLamports(deviceLamports: number, ownerLamports: number): number | null {
  if (deviceLamports >= DEVICE_SOL_MIN) return 0;
  const need = DEVICE_SOL_TARGET - deviceLamports;
  return ownerLamports - OWNER_SOL_RESERVE >= need ? need : null;
}

export async function sendDeviceSol(signer: OwnerSigner, device: string, lamports: number): Promise<string> {
  const ix = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(device), lamports });
  return (await signAndSend(signer, [ix], 'device_topup')).signature;
}

export interface SetupPlan {
  ixs: TransactionInstruction[];
  steps: string[];
  approveTo: string | null;
  allowance: string;
  topUpLamports: number;
}

/** What it takes to let `device` spend up to `allowance` (base units). */
export async function planDeviceSetup(owner: string, device: string, allowance: string, current?: WalletStatus): Promise<SetupPlan> {
  const st = current ?? await readWalletStatus(owner, device);
  const ixs: TransactionInstruction[] = [];
  const steps: string[] = [];
  const want = BigInt(allowance);
  const currentAllowance = BigInt(st.grant?.allowance ?? '0');
  // Delegate: make sure the shared amount covers this device's new room on top of what others had.
  let approveTo: string | null = null;
  const extra = want > currentAllowance ? want - currentAllowance : 0n;
  if (extra > 0n || BigInt(st.delegated) === 0n) {
    approveTo = (BigInt(st.delegated) + (extra > 0n ? extra : want)).toString();
    ixs.push(b.approveDelegate({ owner, amount: approveTo }));
    steps.push(`Approve the dVPN program to spend up to ${tdvpn(approveTo)} tDVPN from your wallet (shared by your devices)`);
  }
  if (!st.grant) {
    ixs.push(await b.openGrant({ owner, grantee: device, allowance }));
    steps.push(`Allow this device to pay nodes for you, up to ${tdvpn(allowance)} tDVPN`);
  } else if (st.grant.allowance !== allowance || (st.grant.permissions & PERMS_CLIENT) !== PERMS_CLIENT) {
    const fixPerms = (st.grant.permissions & PERMS_CLIENT) !== PERMS_CLIENT;
    ixs.push(await b.updateGrant({ owner, grantee: device, allowance, permissions: fixPerms ? Number(BigInt(st.grant.permissions) | BigInt(PERMS_CLIENT)) : undefined }));
    steps.push(st.grant.allowance !== allowance
      ? `Change this device's spending limit from ${tdvpn(st.grant.allowance)} to ${tdvpn(allowance)} tDVPN`
      : 'Let this device open, top up and close deposits for you');
  }
  const topUpLamports = st.deviceLamports < DEVICE_SOL_TARGET ? DEVICE_SOL_TARGET - st.deviceLamports : 0;
  if (topUpLamports > 0) {
    ixs.push(SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(device), lamports: topUpLamports }));
    steps.push(`Send this device ${sol(topUpLamports)} SOL for network fees`);
  }
  return { ixs, steps, approveTo, allowance, topUpLamports };
}

export async function runDeviceSetup(signer: OwnerSigner, device: string, allowance: string): Promise<{ signature: string | null; plan: SetupPlan }> {
  const plan = await planDeviceSetup(signer.publicKey.toBase58(), device, allowance);
  if (!plan.ixs.length) return { signature: null, plan };
  const res = await signAndSend(signer, plan.ixs, 'device_setup');
  return { signature: res.signature, plan };
}

/**
 * Revoke a device. Refused only while it is using a deposit in a live session. Settling never
 * needs the grant: start_close / close / withdraw are signed by the owner and take the grant as
 * an optional account (devnet IDL cf4c372), and nodes redeem without it. So closing or idle
 * deposits still settle and refund after the device is removed (the Linux app 2026-10-22).
 */
export async function revokeDevice(signer: OwnerSigner, device: string, liveSessions: number): Promise<string> {
  if (liveSessions > 0) throw new Error('Disconnect first: this computer is using a deposit right now. Deposits still settle and refund to your wallet after you remove the device.');
  const st = await readWalletStatus(signer.publicKey.toBase58(), device);
  if (!st.grant) throw new Error('This device has no spending permission to remove.');
  const res = await signAndSend(signer, [await b.closeGrant({ owner: signer.publicKey, grantee: device, rentPayer: st.grant.rentPayer })], 'close_grant');
  return res.signature;
}
