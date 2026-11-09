// ─── In-app node testing: pure rules (F20) ───
// The service (main/services/node-test.ts) runs real paid sessions; everything that
// decides a verdict, a cost cap or a summary lives here so it is unit-tested.
import { costPreview, type Basis } from '../pricing/cost';

export type Verdict = 'FAST' | 'SLOW' | 'FAIL' | 'CANCELLED';

export interface NodeTestCheck { name: string; ok: boolean; detail: string }

export interface NodeTestResult {
  node: string;
  service: string;
  country: string;
  verdict: Verdict;
  reason: string;
  basis: Basis;
  connectMs: number | null;
  exitIp: string | null;
  expectedIp: string | null;
  mbps: number | null;
  checks: NodeTestCheck[];
  channel: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number;
}

export interface NodeTestRun {
  id: string; // ISO time, file-name safe
  startedAt: number;
  endedAt: number | null;
  baselineMbps: number | null;
  maxSpend: string; // base units
  estimatedSpend: string; // base units
  total: number;
  done: number;
  stopped: boolean;
  results: NodeTestResult[];
}

export interface NodeTestProgress { runId: string; index: number; total: number; node: string; step: string; done: number }

export const MAX_NODES_PER_RUN = 25;
/** Slow = below this share of the direct baseline, or below the floor when no baseline. */
export const SLOW_SHARE = 0.2;
export const SLOW_FLOOR_MBPS = 1;

/** The cheapest closable deposit: per hour (closes at once) when sold, else 1 GB. */
export function testBasis(node: { pricePerGb: string; pricePerHour: string }): Basis | null {
  if (BigInt(node.pricePerHour || '0') > 0n) return 'per_hour';
  if (BigInt(node.pricePerGb || '0') > 0n) return 'per_gb';
  return null;
}

/** Sum of the deposits a run would lock (the most it can spend). */
export function runEstimate(nodes: Array<{ pricePerGb: string; pricePerHour: string }>): bigint {
  let sum = 0n;
  for (const n of nodes) {
    const b = testBasis(n);
    if (b) sum += BigInt(costPreview(n, b, 1).escrow);
  }
  return sum;
}

/** Host of a node API URI when it is a literal IP (what the exit IP should equal). */
export function uriIp(uri: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:\[([0-9a-f:.]+)\]|([^/:?#]+))/i.exec(uri.trim());
  if (!m) return null;
  if (m[1]) return m[1];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(m[2]) ? m[2] : null;
}

export function verdictFor(r: { connected: boolean; exitOk: boolean | null; mbps: number | null; error?: string | null }, baselineMbps: number | null): { verdict: Verdict; reason: string } {
  if (!r.connected) return { verdict: 'FAIL', reason: r.error || 'Could not connect.' };
  if (r.exitOk === false) return { verdict: 'FAIL', reason: 'Traffic did not leave through this server.' };
  if (r.mbps === null || r.mbps <= 0) return { verdict: 'FAIL', reason: r.error || 'No data came through.' };
  const floor = baselineMbps ? Math.max(SLOW_FLOOR_MBPS, baselineMbps * SLOW_SHARE) : SLOW_FLOOR_MBPS;
  if (r.mbps < floor) return { verdict: 'SLOW', reason: `${r.mbps} Mbps, under ${Math.round(floor * 10) / 10} Mbps${baselineMbps ? ` (${Math.round(SLOW_SHARE * 100)}% of your ${baselineMbps} Mbps without VPN)` : ''}.` };
  return { verdict: 'FAST', reason: `${r.mbps} Mbps${baselineMbps ? ` (${Math.round((r.mbps / baselineMbps) * 100)}% of your speed without VPN)` : ''}.` };
}

export function runSummary(run: NodeTestRun): Record<Verdict, number> {
  const c: Record<Verdict, number> = { FAST: 0, SLOW: 0, FAIL: 0, CANCELLED: 0 };
  for (const r of run.results) c[r.verdict]++;
  return c;
}

/** Nodes that changed verdict between two runs (compare runs, F20.6). */
export function compareRuns(prev: NodeTestRun, next: NodeTestRun): Array<{ node: string; before: Verdict; after: Verdict }> {
  const before = new Map(prev.results.map((r) => [r.node, r.verdict]));
  const out: Array<{ node: string; before: Verdict; after: Verdict }> = [];
  for (const r of next.results) {
    const b = before.get(r.node);
    if (b && b !== r.verdict) out.push({ node: r.node, before: b, after: r.verdict });
  }
  return out;
}

export const runIdFor = (t: number): string => new Date(t).toISOString().replace(/[:.]/g, '-');
