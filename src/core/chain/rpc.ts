// ─── RPC pool with self-healing failover ───
// Ported from plans-solana lib/solana/rpc.js. Every chain read goes through
// rpcCall(); nothing holds a Connection across calls, so a dead or rate-limited
// endpoint is benched and the next call lands elsewhere with no restart.
//
// dvpnd never retries a 429 (sentinel-solana docs/19); here a 429 benches the
// endpoint for 8 s and retries, so one throttled read never fails a screen.
// Difference from the source: the pool is set at runtime from user settings.
import { pinHosts } from '../net/dns-pin';
import { validHost } from '../net/host';
import { Connection, type Commitment } from '@solana/web3.js';

const COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 8_000;
const QUERY_TIMEOUT_MS = 12_000;
export const COMMITMENT: Commitment = 'confirmed';
export const DEFAULT_RPC_URLS = ['https://api.devnet.solana.com'];

let urls: string[] = [...DEFAULT_RPC_URLS];
pinHosts(urls);
const benched = new Map<string, number>();
const connections = new Map<string, Connection>();
let lastServing = urls[0];
let lastSlot: number | null = null;
let lastLatencyMs: number | null = null;
let lastOkAt = 0;
/** A call that worked this recently already proves the endpoint is healthy: skip the extra ping. */
const HEALTH_FRESH_MS = 50_000;

/** https anywhere, plain http only to loopback (a local validator / proxy). */
export function isValidRpcUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (!validHost(u.hostname)) return false; // WHATWG URL accepts hosts like x"y (the Android app)
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return false;
  } catch (err) {
    console.warn(`[rpc] rejected RPC url: ${(err as Error).message}`);
    return false;
  }
}

/** Replace the pool. Invalid entries are dropped; an empty result falls back to the defaults. */
export function setRpcUrls(next: string[]): string[] {
  const clean = [...new Set(next.map((s) => s.trim()).filter(Boolean).filter(isValidRpcUrl))];
  urls = clean.length ? clean : [...DEFAULT_RPC_URLS];
  pinHosts(urls);
  benched.clear();
  for (const k of [...connections.keys()]) if (!urls.includes(k)) connections.delete(k);
  lastServing = urls[0];
  return [...urls];
}

/**
 * The network path just changed (a VPN session started or ended). Each cached Connection
 * keeps its own keep-alive sockets, opened on the OLD route; they fail with "fetch failed"
 * once the tunnel takes the default route, and that benched the only endpoint for 60 s
 * after every connect (laptop + clean-VM runs 2026-10-20). Drop them and the benches.
 */
export function resetRpcTransport(): void {
  connections.clear();
  benched.clear();
  dropFetchPool();
  routeChangedAt = Date.now();
}

// ─── Node's own fetch pool (Q0390) ───
// web3.js calls Node's built-in fetch when there is one, and that ignores web3's keep-alive agent:
// every RPC socket lives in ONE global pool (undici), which connections.clear() never touched. On a
// server switch with the kill switch held (Azure deb12, TLX2 10-30), getSlot reused the sockets opened
// on the old tunnel route and timed out 3 s each, while a fresh connection answered in 0.16 s; the
// switch failed with "your internet has not come back yet". Swap the pool for a new one, close the old.
const FETCH_POOL = Symbol.for('undici.globalDispatcher.1');
type Pool = { constructor: new () => Pool; destroy?: () => Promise<void> };

/** Replace Node's global fetch pool with a fresh one and destroy the old (its sockets use the old route). Exported for tests. */
export function dropFetchPool(): boolean {
  const g = globalThis as unknown as Record<symbol, Pool | undefined>;
  const old = g[FETCH_POOL];
  if (!old || typeof old.destroy !== 'function') return false; // no fetch made yet: nothing pooled
  try {
    g[FETCH_POOL] = new old.constructor();
  } catch (err) {
    console.warn(`[rpc] could not replace the fetch pool: ${(err as Error).message}`);
    return false;
  }
  old.destroy().catch((err: Error) => console.warn(`[rpc] closing the old fetch pool: ${err.message}`));
  return true;
}
let routeChangedAt = 0;
const SETTLING_MS = 20_000;
const SETTLING_COOLDOWN_MS = 3_000;

/** How long a transport failure benches an endpoint (short while routes/DNS settle). Exported for tests. */
export function benchMs(err: unknown, now = Date.now()): number {
  if (isRateLimited(err)) return RATE_LIMIT_COOLDOWN_MS;
  return now - routeChangedAt < SETTLING_MS ? SETTLING_COOLDOWN_MS : COOLDOWN_MS;
}

export function getRpcUrls(): string[] {
  return [...urls];
}

function connectionFor(url: string): Connection {
  let c = connections.get(url);
  if (!c) {
    c = new Connection(url, {
      commitment: COMMITMENT,
      disableRetryOnRateLimit: true, // we bench + rotate instead of web3's in-place sleep/retry
      confirmTransactionInitialTimeout: 60_000,
    });
    connections.set(url, c);
  }
  return c;
}

/** Candidate endpoints in priority order, benched ones last (never empty). */
export function rpcCandidates(): string[] {
  const now = Date.now();
  const live = urls.filter((u) => !((benched.get(u) ?? 0) > now));
  const cold = urls.filter((u) => (benched.get(u) ?? 0) > now);
  return live.length ? [...live, ...cold] : [...urls];
}

export function benchEndpoint(url: string, reason: string, ms = COOLDOWN_MS): void {
  benched.set(url, Date.now() + ms);
  console.warn(`[rpc] benched ${redactUrl(url)} for ${ms / 1000}s: ${reason}`);
}

export function isRateLimited(err: unknown): boolean {
  return /429|Too Many Requests|rate limit/i.test(String((err as Error)?.message ?? err ?? ''));
}

export const RPC_UNAVAILABLE = 'RpcUnavailable';

export function isTransportError(err: unknown): boolean {
  if ((err as { name?: string } | null)?.name === RPC_UNAVAILABLE) return true;
  // A rejected send carries program logs that can contain 429/502 by accident:
  // the node answered, so it is never a transport failure.
  const e = err as { transactionMessage?: unknown; transactionLogs?: unknown; name?: string; message?: string } | null;
  if (e && typeof e === 'object' && (e.transactionMessage !== undefined || e.transactionLogs !== undefined || e.name === 'SendTransactionError')) return false;
  const m = String(e?.message ?? err ?? '').split('\n')[0];
  return /\b(429|502|503|504)\b|Too Many Requests|rate limit|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timed out|timeout|Gateway|network error|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(m) || isNotRpcReply(m);
}

/**
 * The endpoint answered, but not as a Solana RPC: an HTTP error status with a web page, or a body
 * that is not JSON (W-RPC-GARBAGE: `rpc set https://example.com` → "405 Method Not Allowed:
 * <!doctype html>…" shown raw). web3.js builds "<status> <statusText>: <body>" only for a non-2xx
 * reply, so this never matches a chain-level JSON-RPC error. 400 and 413 stay out: an RPC can send
 * them for a request it understood.
 */
export function isNotRpcReply(message: string): boolean {
  return /\b(401|403|404|405|410|500|501|505)\s+[A-Za-z][A-Za-z' -]*:|<!doctype html|<html[\s>]|Unexpected token .{0,20}JSON|is not valid JSON/i.test(message);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface RpcCallOpts<T> {
  label?: string;
  attempts?: number;
  timeoutMs?: number;
  /** One deadline for the whole call, retries and bench waits included (default timeoutMs + 8 s). */
  deadlineMs?: number;
  fallback?: T;
}

/** Extra time a call gets past one attempt's timeout for its retries (G31: a dead endpoint cost ~46 s, silent). */
export const RETRY_GRACE_MS = 8_000;
/** A transport failure this slow (or after 3/4 of its attempt) is an endpoint that never answered: undici's connect timeout is 10 s. */
const NO_ANSWER_MS = 9_000;
/** Below this much time left, another attempt cannot finish: stop. */
const MIN_ATTEMPT_MS = 1_000;

// Since when each endpoint has had a request out with no answer. Concurrent reads share one pending
// connect, so a read that started later fails in the same millisecond as the first and its own timer
// reads short (G31 live, Android: config + node reads both failed 10.6 s into the connect, the node
// read's own clock said < 9 s and the copy said "check your internet connection").
const silentSince = new Map<string, { since: number; open: number }>();
function silenceBegin(url: string, now: number): void {
  const s = silentSince.get(url);
  if (s) s.open += 1;
  else silentSince.set(url, { since: now, open: 1 });
}
function silenceEnd(url: string, answered: boolean): void {
  const s = silentSince.get(url);
  if (!s) return;
  s.open -= 1;
  if (s.open <= 0) silentSince.delete(url);
  else if (answered) s.since = Date.now();
}

type RetryListener = (e: { label: string; attempt: number; error: string; leftMs: number }) => void;
const retryListeners = new Set<RetryListener>();
/** Hear every failed attempt that will be retried (the connect flow shows "waiting for the network"). */
export function onRpcRetry(fn: RetryListener): () => void {
  retryListeners.add(fn);
  return () => retryListeners.delete(fn);
}

/**
 * Run `fn(connection)` against the pool. Transport failures bench the endpoint
 * and retry on the next one; chain-level errors propagate immediately.
 */
// Calls per label since start (T5 proof: each source is read once at startup, then on its timer).
const callCounts = new Map<string, number>();
export const rpcCallCounts = (): Record<string, number> => Object.fromEntries(callCounts);

export async function rpcCall<T>(fn: (c: Connection, url: string) => Promise<T>, opts: RpcCallOpts<T> = {}): Promise<T> {
  const { label = 'rpc', attempts = 3, timeoutMs = QUERY_TIMEOUT_MS } = opts;
  const deadline = Date.now() + (opts.deadlineMs ?? timeoutMs + RETRY_GRACE_MS);
  callCounts.set(label, (callCounts.get(label) ?? 0) + 1);
  const errors: string[] = [];
  const tried = new Set<string>();
  for (let i = 0; i < attempts; i++) {
    const candidates = rpcCandidates();
    const url = candidates.find((u) => !tried.has(u)) ?? candidates[0];
    tried.add(url);
    const until = benched.get(url) ?? 0;
    if (until > Date.now()) await sleep(Math.max(0, Math.min(until - Date.now(), 2000 * (i + 1), deadline - Date.now() - MIN_ATTEMPT_MS)));
    const left = deadline - Date.now();
    if (i > 0 && left < MIN_ATTEMPT_MS) {
      errors.push(`gave up: the ${Math.round((opts.deadlineMs ?? timeoutMs + RETRY_GRACE_MS) / 1000)} s limit for this read passed`);
      break;
    }
    const started = Date.now();
    const attemptMs = i === 0 ? timeoutMs : Math.min(timeoutMs, left);
    silenceBegin(url, started);
    let quietMs = 0;
    try {
      const out = await withTimeout(fn(connectionFor(url), url), attemptMs, label);
      silenceEnd(url, true);
      lastServing = url;
      lastLatencyMs = Date.now() - started;
      lastOkAt = Date.now();
      return out;
    } catch (err) {
      quietMs = Date.now() - Math.min(started, silentSince.get(url)?.since ?? started);
      silenceEnd(url, false);
      if (!isTransportError(err)) throw err;
      const msg = (err as Error).message ?? String(err);
      // A connect that never answers fails as a bare "fetch failed" after undici's 10 s connect timeout
      // (the library's message drops the cause). A failure after the endpoint was silent for most of an
      // attempt is "no answer", not "unreachable" (G31 live, QA-u22: a blackholed endpoint read "check
      // your internet connection"). Silence counts from the endpoint's oldest open request (silentSince).
      const noAnswer = !/timed out|timeout|ETIMEDOUT/i.test(msg) && quietMs >= Math.min(NO_ANSWER_MS, attemptMs * 0.75);
      errors.push(`${redactUrl(url)}: ${msg.split('\n')[0].slice(0, 160)}${noAnswer ? ` (no answer after ${Math.round(quietMs / 1000)} s)` : ''}`);
      benchEndpoint(url, `${label}: ${msg.slice(0, 120)}`, benchMs(err));
      if (i + 1 < attempts) {
        const ev = { label, attempt: i + 1, error: msg.split('\n')[0].slice(0, 160), leftMs: Math.max(0, deadline - Date.now()) };
        console.warn(`[rpc] ${label}: attempt ${ev.attempt} of ${attempts} failed (${ev.error}); retrying, ${Math.round(ev.leftMs / 1000)} s left`);
        for (const l of retryListeners) {
          try {
            l(ev);
          } catch (lerr) {
            console.warn(`[rpc] retry listener failed: ${(lerr as Error).message}`);
          }
        }
      }
    }
  }
  if ('fallback' in opts) {
    console.error(`[rpc] ${label} failed on every endpoint, using fallback:\n  ${errors.join('\n  ')}`);
    return opts.fallback as T;
  }
  const exhausted = new Error(`${label}: all RPC endpoints failed:\n  ${errors.join('\n  ')}`);
  exhausted.name = RPC_UNAVAILABLE;  // only transport errors get here, so isTransportError must say so
  throw exhausted;
}

/** The Connection currently preferred for building / sending. */
export function sendConnection(): Connection {
  return connectionFor(rpcCandidates()[0]);
}

/** Hide API keys carried in query strings / paths before a URL is shown or logged. */
export function redactUrl(url: string): string {
  try {
    // Built as text, not through URL setters: those percent-encode the marker to %3Credacted%3E,
    // which showed in Diagnostics and slipped past the "unchanged, keep the stored key" check on
    // save (ipc.ts looks for the literal <redacted>). Credentials in the URL are dropped too.
    const u = new URL(url);
    const path = u.pathname.split('/').map((p) => (p.length >= 20 && /^[A-Za-z0-9_-]+$/.test(p) ? '<redacted>' : p)).join('/');
    return `${u.protocol}//${u.host}${path}${u.search ? '?<redacted>' : ''}`;
  } catch (err) {
    console.warn(`[rpc] redactUrl: ${(err as Error).message}`);
    return '<unparseable url>';
  }
}

export interface RpcState {
  serving: string;
  slot: number | null;
  latencyMs: number | null;
  pool: string[];
  benched: Array<{ url: string; untilMs: number }>;
  publicOnly: boolean;
}

export async function getRpcState(): Promise<RpcState> {
  const now = Date.now();
  if (lastSlot === null || now - lastOkAt > HEALTH_FRESH_MS) {
    try {
      lastSlot = await rpcCall((c) => c.getSlot(COMMITMENT), { label: 'health:slot', attempts: 2, timeoutMs: 6000 });
    } catch (err) {
      lastSlot = null;
      console.warn(`[rpc] health slot read failed: ${(err as Error).message}`);
    }
  }
  return {
    serving: redactUrl(lastServing),
    slot: lastSlot,
    latencyMs: lastLatencyMs,
    pool: urls.map(redactUrl),
    benched: urls.filter((u) => (benched.get(u) ?? 0) > now).map((u) => ({ url: redactUrl(u), untilMs: (benched.get(u) ?? 0) - now })),
    // Public devnet RPC 429s under real use (docs/19): the UI warns while it is the only endpoint.
    publicOnly: urls.every((u) => /api\.devnet\.solana\.com/.test(u)),
  };
}

/** Plain words for a read that failed on every endpoint (the raw list stays in the log). Matrix
 *  2026-10-22: a 429 on the public endpoint reached the user as a multi-line "config: all RPC
 *  endpoints failed" dump. Returns null for any other error. */
export function rpcUnavailableCopy(err: unknown): { message: string; action: string } | null {
  const e = err as Error | undefined;
  // dvpnd relays the same exhaustion over gRPC as a plain Error ("node:<id>: all RPC endpoints failed: ..."), so the name is gone: match the text too.
  if (!e || (e.name !== RPC_UNAVAILABLE && !/all RPC endpoints failed/.test(String(e.message)))) return null;
  const busy = /429|Too Many Requests|rate limit/i.test(e.message);
  // Every endpoint answered with a web page or HTTP error: the address is wrong, not the internet.
  const lines = String(e.message).split('\n').slice(1).filter((l) => l.trim());
  const notRpc = lines.length > 0 && lines.every((l) => isNotRpcReply(l));
  // Every try ran out of time (G31): the endpoint is up but not answering, which is not the user's internet.
  const tries = lines.filter((l) => !/^\s*gave up:/.test(l));
  const slow = tries.length > 0 && tries.every((l) => /timed out|timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|\(no answer after \d+ s\)/i.test(l));
  return {
    message: busy
      ? 'The Solana network endpoint is rate-limiting requests right now. Wait a minute and try again.'
      : notRpc
        ? 'The Solana network endpoint did not answer like a Solana RPC endpoint. Check the endpoint address.'
        : slow
          ? 'The Solana network is slow to answer. Try again, or set a different RPC endpoint in Settings.'
          : 'The Solana network endpoint could not be reached. Check your internet connection and try again.',
    action: 'Or use your own endpoint: devnet-dvpn rpc set <url>',
  };
}
