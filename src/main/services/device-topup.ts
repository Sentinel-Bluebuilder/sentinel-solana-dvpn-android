// ─── Keep the device's SOL topped up before a connect (setting autoTopUpDevice) ───
// The device pays each new deposit account's rent (~0.004 SOL, back when it is settled) and
// fees. Without this a busy device runs dry and every connect stops at "needs a little SOL".
// Only with the in-app wallet key: a browser-wallet (cold) owner is never asked to sign here.
import { deviceTopUpLamports, sendDeviceSol } from '../../core/app/device-setup';
import type { WalletStatus } from '../../core/app/wallet-status';
import { sol } from '../../shared/format';
import { ownerKeypair, ownerSigner } from '../wallet/vault';
import { getSettings } from '../system/settings';
import { toast } from '../app-state';
import { log } from '../logger';

export type TopUpOutcome = { done: false; reason: 'not-needed' | 'off' | 'no-key' | 'owner-short' | 'failed'; detail?: string } | { done: true; lamports: number; signature: string };

/** Tops the device up when it is low. Never throws; a failure leaves the normal "needs SOL" message to the caller. */
export async function topUpDeviceIfLow(w: WalletStatus, device: string): Promise<TopUpOutcome> {
  const lamports = deviceTopUpLamports(w.deviceLamports, w.ownerLamports);
  if (lamports === 0) return { done: false, reason: 'not-needed' };
  if (!getSettings().autoTopUpDevice) return { done: false, reason: 'off' };
  if (!ownerKeypair()) return { done: false, reason: 'no-key' };
  if (lamports === null) return { done: false, reason: 'owner-short' };
  try {
    const signature = await sendDeviceSol(ownerSigner(), device, lamports);
    log.info('device topped up for fees', { lamports, signature });
    toast('info', `Sent this device ${sol(lamports)} SOL from your wallet for network fees.`);
    return { done: true, lamports, signature };
  } catch (err) {
    const detail = (err as Error).message.split('\n')[0];
    log.warn('device top-up failed', { err: detail });
    return { done: false, reason: 'failed', detail };
  }
}
