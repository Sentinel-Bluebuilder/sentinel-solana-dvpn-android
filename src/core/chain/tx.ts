// ─── Transaction build / simulate / send / confirm ───
// Ported from plans-solana lib/solana/tx.js. One write path:
//   const built = await buildTx(ixs, owner, { label })   // simulate first
//   const signed = await signer.sign(built.tx)            // in-app key or browser wallet
//   const res = await sendSigned(signed, built)           // idempotent resend + confirm
// Every tx is simulated BEFORE anyone signs it, so a program error reaches the
// user as a named error instead of a signature followed by a failure.
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { b58encode } from './b58';
import { rpcCall, isTransportError, COMMITMENT } from './rpc';
import { PROGRAM_ID } from './idl';
import { ProgramError } from './errors';

const CU_MARGIN = 1.2; // dvpnctl compute_unit_margin = 20 %
const CU_FLOOR = 20_000;
const CU_CEIL = 1_400_000;
const MAX_PRIORITY_FEE = 100_000; // µ-lamports / CU, dvpnctl's max_priority_fee
const CONFIRM_TIMEOUT_MS = 60_000;

export const ALLOWED_PROGRAMS = [
  PROGRAM_ID,
  SystemProgram.programId,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ComputeBudgetProgram.programId,
].map((k) => k.toBase58());

async function priorityFee(ixs: TransactionInstruction[]): Promise<number> {
  const writable = [...new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))]
    .slice(0, 128).map((k) => new PublicKey(k));
  try {
    const fees = await rpcCall((c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: writable }), { label: 'priorityFee', attempts: 1, timeoutMs: 5000 });
    const vals = fees.map((f) => f.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
    if (!vals.length) return 0;
    return Math.min(MAX_PRIORITY_FEE, vals[Math.floor(vals.length / 2)]);
  } catch (err) {
    console.warn(`[tx] priority fee lookup failed, using 0: ${(err as Error).message}`);
    return 0;
  }
}

export interface BuiltTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  unitsConsumed: number | undefined;
  priorityFee: number;
  logs: string[] | null;
  label: string;
}

/** Simulate for CU and errors, then prepend compute-budget instructions. Throws ProgramError. */
export async function buildTx(ixs: TransactionInstruction[], feePayer: PublicKey | string, { label = 'tx' } = {}): Promise<BuiltTx> {
  if (!ixs.length) throw new Error(`${label}: no instructions`); // copy:internal
  const payer = new PublicKey(feePayer);
  const { blockhash, lastValidBlockHeight } = await rpcCall((c) => c.getLatestBlockhash(COMMITMENT), { label: `${label}:blockhash` });
  const probe = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await rpcCall((c) => c.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT }), { label: `${label}:simulate` });
  if (sim.value.err) throw new ProgramError({ err: sim.value.err, logs: sim.value.logs }, { logs: sim.value.logs });
  const units = Math.min(CU_CEIL, Math.max(CU_FLOOR, Math.ceil((sim.value.unitsConsumed || CU_FLOOR) * CU_MARGIN)));
  const fee = await priorityFee(ixs);
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (fee > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message());
  return { tx, blockhash, lastValidBlockHeight, unitsConsumed: sim.value.unitsConsumed, priorityFee: fee, logs: sim.value.logs, label };
}

export interface TxResult {
  ok: true;
  signature: string;
  slot: number;
}

/** Send a fully signed tx and wait for `confirmed`. */
export async function sendSigned(tx: VersionedTransaction, { lastValidBlockHeight, label = 'tx' }: { lastValidBlockHeight?: number; label?: string } = {}): Promise<TxResult> {
  const raw = tx.serialize();
  const expected = b58encode(tx.signatures[0]);
  let signature: string;
  try {
    // Identical signed bytes resend idempotently (same signature), so transport failures retry safely.
    signature = await rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3 }), { label: `${label}:send`, timeoutMs: 30_000 });
  } catch (err) {
    // A lost send response followed by a retry lands here: the tx IS on chain, so confirm it.
    if (/already been processed|AlreadyProcessed/i.test(String((err as Error)?.message ?? ''))) signature = expected;
    else if (isTransportError(err)) throw err;
    else throw new ProgramError(err, { logs: (err as { logs?: string[] }).logs ?? null });
  }
  let lvbh = lastValidBlockHeight;
  if (!lvbh) {
    const bh = await rpcCall((c) => c.getLatestBlockhash(COMMITMENT), { label: `${label}:blockhash` });
    lvbh = bh.lastValidBlockHeight;
  }
  return confirmSignature(signature, lvbh, label);
}

/** Confirmation polled through the RPC pool, so one 429 never turns a landed tx into a failure. */
export async function confirmSignature(signature: string, lastValidBlockHeight: number, label: string): Promise<TxResult> {
  // RPC budget: one status read every 2 s; the expiry check (block height) only every 4th
  // round (~8 s; a blockhash lives ~60-90 s). Was 2 reads per 1.5 s. (Same fix as the Linux app f0fe423.)
  // The tx is already sent: a rate-limited or failed READ says nothing about it, so keep polling
  // (slower) until the deadline. Seen 2026-10-21: device setup landed, 2 status reads hit 429,
  // and the user was told it failed (test-host).
  const started = Date.now();
  let pause = 2000;
  let lastReadError = '';
  for (let round = 1; Date.now() - started < CONFIRM_TIMEOUT_MS; round++) {
    try {
      const st = await rpcCall((c) => c.getSignatureStatuses([signature]), { label: `${label}:status`, attempts: 2, timeoutMs: 8000 });
      const v = st.value[0];
      if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
        if (v.err) throw new ProgramError({ err: v.err, message: `Transaction ${signature} failed.` });
        return { ok: true, signature, slot: v.slot };
      }
      if (round % 4 === 0) {
        const height = await rpcCall((c) => c.getBlockHeight(COMMITMENT), { label: `${label}:height`, attempts: 2, timeoutMs: 8000 });
        if (height > lastValidBlockHeight) throw new Error(`${label}: transaction ${signature} expired before confirmation.`);
      }
      pause = 2000;
    } catch (err) {
      if (!isTransportError(err)) throw err;
      lastReadError = String((err as Error)?.message ?? err).slice(0, 160);
      pause = Math.min(pause * 2, 8000);
    }
    await new Promise((r) => setTimeout(r, pause));
  }
  throw new Error(`${label}: sent but not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s (signature ${signature}); it may still land, so check again before retrying${lastReadError ? `. Last read error: ${lastReadError}` : ''}`);
}

export function encodeTx(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64');
}

export function decodeTx(b64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(String(b64), 'base64'));
}

/** Browser-wallet relay guard: fee payer = owner, allow-listed programs only, no lookup tables. */
export function assertRelayable(tx: VersionedTransaction, owner: PublicKey | string): void {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys[0] || !keys[0].equals(new PublicKey(owner))) throw new Error('Signed transaction fee payer does not match your wallet.');
  for (const ci of msg.compiledInstructions) {
    const pid = keys[ci.programIdIndex];
    if (!pid || !ALLOWED_PROGRAMS.includes(pid.toBase58())) throw new Error(`Transaction calls a program the app does not accept: ${pid ? pid.toBase58() : '?'}`);
  }
  if (msg.addressTableLookups?.length) throw new Error('Address lookup tables are not accepted.');
}

/** Same instructions as `built` (ignoring the compute-budget prefix)? Guards the relay against a swapped tx. */
export function sameMessage(a: VersionedTransaction, b: VersionedTransaction): boolean {
  return Buffer.from(a.message.serialize()).equals(Buffer.from(b.message.serialize()));
}

// ─── Per-signer send queue: two writes never race the same blockhash window ───
let queue: Promise<unknown> = Promise.resolve();
export function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch((err) => console.warn(`[tx] queued write failed: ${(err as Error).message}`));
  return p;
}
