// ─── Polling cadences (F5) — one table for settings, scheduler, CLI and UI ───
// Seconds. Defaults follow FEATURE-PLAN F5; min/max keep a user from hammering the RPC
// (public devnet rate-limits) or leaving data stale for hours.

export const POLL_JOBS = {
  wallet: { label: 'Wallet balances', def: 60, min: 15, max: 3600 },
  nodes: { label: 'Node list', def: 300, min: 60, max: 3600 },
  plans: { label: 'Plans', def: 600, min: 60, max: 7200 },
  subscriptions: { label: 'Subscriptions', def: 600, min: 60, max: 7200 },
  settlements: { label: 'Pending refunds', def: 60, min: 15, max: 3600 },
  ip: { label: 'Public IP while connected', def: 30, min: 10, max: 600 },
  dns: { label: 'DNS label', def: 15, min: 5, max: 600 },
  rpc: { label: 'RPC health', def: 60, min: 15, max: 3600 },
  session: { label: 'Session check (finds a session started elsewhere; fallback when the live stream drops)', def: 5, min: 2, max: 60 },
} as const;

export type PollJob = keyof typeof POLL_JOBS;
export type PollSettings = Record<PollJob, number>;

export const POLL_JOB_NAMES = Object.keys(POLL_JOBS) as PollJob[];

export const DEFAULT_POLL: PollSettings = Object.fromEntries(POLL_JOB_NAMES.map((k) => [k, POLL_JOBS[k].def])) as PollSettings;

/** A whole number of seconds inside the job's range, or null when it is not one. */
export function validPoll(job: string, value: unknown): number | null {
  if (!(job in POLL_JOBS)) return null;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  const j = POLL_JOBS[job as PollJob];
  return n >= j.min && n <= j.max ? n : null;
}

/** Keep valid entries of `input`, fill the rest from `base`. Unknown jobs are dropped. */
export function sanitizePoll(input: unknown, base: PollSettings = DEFAULT_POLL): PollSettings {
  const out: PollSettings = { ...DEFAULT_POLL, ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const n = validPoll(k, v);
    if (n !== null) out[k as PollJob] = n;
  }
  return out;
}
