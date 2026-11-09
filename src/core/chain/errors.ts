// ─── Program error decoding ───
// Ported from plans-solana lib/solana/errors.js. Since the 2026-10-21 12:37 UTC redeploy the
// devnet program (upstream cb33092e since 11-02) numbers its errors exactly as the bundled
// IDL does (the old 6022–6038 shift is gone). Branch on NUMBERS, translate here.
import { loadIdl } from './idl';

export interface ProgramErrorDesc {
  code: number;
  name: string;
  message: string;
}

let sourceTableCache: Map<number, ProgramErrorDesc> | null = null;
function sourceTable(): Map<number, ProgramErrorDesc> {
  if (sourceTableCache) return sourceTableCache;
  sourceTableCache = new Map();
  for (const e of loadIdl().errors ?? []) sourceTableCache.set(e.code, { code: e.code, name: e.name, message: e.msg ?? '' });
  return sourceTableCache;
}

const ANCHOR_FRAMEWORK: Record<number, [string, string]> = {
  100: ['InstructionMissing', 'instruction discriminator not provided'],
  101: ['InstructionFallbackNotFound', 'fallback not found'],
  102: ['InstructionDidNotDeserialize', 'the program could not deserialize the instruction data'],
  2000: ['ConstraintMut', 'a mut constraint was violated'],
  2001: ['ConstraintHasOne', 'a has one constraint was violated'],
  2002: ['ConstraintSigner', 'a signer constraint was violated'],
  2003: ['ConstraintRaw', 'a raw constraint was violated'],
  2006: ['ConstraintSeeds', 'a seeds constraint was violated'],
  2012: ['ConstraintAddress', 'an address constraint was violated'],
  2014: ['ConstraintTokenMint', 'a token mint constraint was violated'],
  2015: ['ConstraintTokenOwner', 'a token owner constraint was violated'],
  2019: ['ConstraintAccountIsNone', 'a required account was not provided'],
  3005: ['AccountDidNotSerialize', 'failed to serialize the account'],
  3007: ['AccountOwnedByWrongProgram', 'the given account is owned by a different program than expected'],
  3012: ['AccountNotInitialized', 'the program expected this account to be already initialized'],
};

/** Translate a code as the devnet chain reports it into a name + message. */
export function describeProgramError(code: number): ProgramErrorDesc {
  const n = Number(code);
  const hit = sourceTable().get(n);
  if (hit) return { ...hit, code: n };
  const fw = ANCHOR_FRAMEWORK[n];
  if (fw) return { code: n, name: fw[0], message: fw[1] };
  return { code: n, name: `Program error ${n}`, message: '' };
}

/** Code → number lookup by name (so callers can branch on a NAME safely). */
export function devnetCodeOf(name: string): number | null {
  for (const [code, e] of sourceTable()) if (e.name === name) return code;
  return null;
}

/** Pull a program error code out of anything the RPC / web3.js hands back. */
export function extractErrorCode(errOrLogs: unknown): number | null {
  const texts: string[] = [];
  const push = (x: unknown): void => {
    if (x !== undefined && x !== null) texts.push(typeof x === 'string' ? x : safeJson(x));
  };
  if (Array.isArray(errOrLogs)) errOrLogs.forEach(push);
  else if (errOrLogs && typeof errOrLogs === 'object') {
    const o = errOrLogs as Record<string, unknown>;
    // A bare transaction error (simulation value.err), e.g. { InstructionError: [0, { Custom: 102 }] }.
    if (!['message', 'err', 'transactionError', 'logs', 'transactionLogs'].some((k) => k in o)) push(o);
    push(o.message);
    push(o.err);
    push(o.transactionError);
    if (Array.isArray(o.logs)) o.logs.forEach(push);
    if (Array.isArray(o.transactionLogs)) o.transactionLogs.forEach(push);
  } else push(errOrLogs);
  const blob = texts.join('\n');
  let m = blob.match(/Error Number:\s*(\d+)/);
  if (m) return Number(m[1]);
  m = blob.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (m) return parseInt(m[1], 16);
  m = blob.match(/"Custom"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  return null;
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch (err) {
    return `[unserialisable: ${(err as Error).message}]`;
  }
}

export function describeInstructionError(errObj: unknown): string | null {
  const s = typeof errObj === 'string' ? errObj : safeJson(errObj ?? '');
  // Solana raises this for ANY account left between 0 and its rent minimum — usually the sender
  // (seen 2026-10-20: sending nearly all SOL from a wallet to an existing account).
  if (/InsufficientFundsForRent/.test(s)) return 'This would leave an account below Solana\'s minimum balance (about 0.001 SOL). Send a little less.';
  if (/InsufficientFunds/.test(s)) return 'Insufficient funds';
  if (/AccountNotFound/.test(s)) return 'The fee payer has no SOL';
  if (/BlockhashNotFound/.test(s)) return 'The transaction expired before it landed — try again';
  if (/AlreadyProcessed|already been processed/i.test(s)) return 'Transaction already processed';
  if (/ProgramFailedToComplete|ComputationalBudgetExceeded/.test(s)) return 'Compute budget exceeded';
  return null;
}

/** One Error carrying the decoded program error (simulation or send). */
export class ProgramError extends Error {
  code: number | null;
  programError: ProgramErrorDesc | null;
  logs: string[] | null;

  constructor(source: unknown, opts: { logs?: string[] | null } = {}) {
    const code = extractErrorCode(source);
    const desc = code !== null ? describeProgramError(code) : null;
    const src = source as { logs?: string[]; err?: unknown; message?: string } | null;
    const logs = opts.logs ?? src?.logs ?? null;
    const logText = (logs ?? []).join('\n');
    const solInsufficient = /insufficient lamports/i.test(logText);
    const tokenInsufficient = code === 1 && !solInsufficient && /Tokenz|Token-2022|insufficient funds/i.test(logText);
    // System Program error 0 = AccountAlreadyInUse: the account an instruction creates exists.
    // Seen on a second `plans subscribe` (a wallet holds one subscription per plan) as the bare
    // "Program error 0 (0):". H1: an EXPIRED subscription stays until it is closed, so waiting does not help.
    const alreadyInUse = code === 0 && /already in use/i.test(logText);
    let message: string;
    if (alreadyInUse) message = 'This wallet already has a subscription to this plan, and a wallet can hold only one per plan. An ended subscription stays until you remove it (Plans, then Remove); after that you can subscribe again.';
    else if (desc && code !== null && code >= 6000) message = `${desc.name} (${code}): ${desc.message}`;
    else if (solInsufficient) message = 'Not enough SOL';
    else if (tokenInsufficient) message = 'Not enough tDVPN';
    else if (desc && code !== null) message = `${desc.name} (${code}): ${desc.message}`;
    else message = describeInstructionError(src?.err ?? source) ?? src?.message ?? String(source);
    super(message);
    this.name = 'ProgramError';
    this.code = code;
    this.programError = desc;
    this.logs = logs;
  }
}
