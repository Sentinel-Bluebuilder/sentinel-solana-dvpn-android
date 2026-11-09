// ─── Wallet + device status (F2, F3, F8.6) ───
// Everything the UI needs to answer "can I pay?" in one read: owner SOL/tDVPN,
// the shared Token-2022 delegate (Config PDA) amount, refundable User.balance,
// the device grant allowance, and the device's SOL for fees + channel rent.
import { PublicKey } from '@solana/web3.js';
import { getAccount, TOKEN_2022_PROGRAM_ID, TokenAccountNotFoundError } from '@solana/spl-token';
import { rpcCall } from '../chain/rpc';
import { ata, pda } from '../chain/program';
import { PERMS_CLIENT } from '../chain/idl';
import { DEVICE_MIN_LAMPORTS } from '../session/setup-gate';
import { grantOf, userByOwner } from '../chain/accounts';

export interface WalletStatus {
  owner: string;
  device: string | null;
  ownerLamports: number;
  ownerTdvpn: string;      // base units in the owner's ATA
  delegated: string;       // base units the Config PDA may pull (shared by every device)
  userBalance: string;     // refundable, waiting for withdraw
  userExists: boolean;
  userOpenChannels: number;
  userRentPayer: string | null;
  grant: { allowance: string; rentPayer: string; permissions: number } | null;
  deviceLamports: number;
  ready: boolean;          // grant + delegate + device SOL all present
  at: number;
}

export async function readWalletStatus(owner: string, device: string | null): Promise<WalletStatus> {
  const ownerPk = new PublicKey(owner);
  const [lamports, tokenAcct, user, grant, deviceLamports] = await Promise.all([
    rpcCall((c) => c.getBalance(ownerPk, 'confirmed'), { label: 'owner:sol' }),
    rpcCall(async (c) => {
      try {
        return await getAccount(c, ata(ownerPk), 'confirmed', TOKEN_2022_PROGRAM_ID);
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) return null;
        throw err;
      }
    }, { label: 'owner:ata' }),
    userByOwner(ownerPk),
    device ? grantOf(ownerPk, device) : Promise.resolve(null),
    device ? rpcCall((c) => c.getBalance(new PublicKey(device), 'confirmed'), { label: 'device:sol' }) : Promise.resolve(0),
  ]);
  const delegated = tokenAcct && tokenAcct.delegate && tokenAcct.delegate.equals(pda.config()) ? tokenAcct.delegatedAmount.toString() : '0';
  const status: WalletStatus = {
    owner,
    device,
    ownerLamports: lamports,
    ownerTdvpn: tokenAcct ? tokenAcct.amount.toString() : '0',
    delegated,
    userBalance: user ? String(user.balance) : '0',
    userExists: !!user,
    userOpenChannels: user ? Number(user.openChannels) : 0,
    userRentPayer: user ? String(user.rentRecipient) : null,
    grant: grant ? { allowance: String(grant.allowance), rentPayer: String(grant.rentRecipient), permissions: Number(grant.permissions) } : null,
    deviceLamports,
    ready: false,
    at: Date.now(),
  };
  status.ready = !!status.grant && (status.grant.permissions & PERMS_CLIENT) === PERMS_CLIENT && BigInt(status.delegated) > 0n && status.deviceLamports >= DEVICE_MIN_LAMPORTS;
  return status;
}

/** Funding problems worth a notification, keyed so each is raised once per crossing (F21.3). */
export function lowFundsWarnings(w: WalletStatus): Array<{ key: string; message: string }> {
  if (!w.ready) return [];
  const out: Array<{ key: string; message: string }> = [];
  if (w.deviceLamports < 10_000_000) out.push({ key: 'device-sol', message: 'The device is low on SOL for fees. Top it up in Wallet.' });
  if (BigInt(w.ownerTdvpn) + BigInt(w.userBalance) < 1_000_000n) out.push({ key: 'tdvpn', message: 'Your wallet has under 1 tDVPN. Deposits will fail until you add more.' });
  if (w.grant && BigInt(w.grant.allowance) < 1_000_000n) out.push({ key: 'allowance', message: 'The device spending limit is almost used up. Raise it in Wallet.' });
  return out;
}
