// ─── In-app node testing (F20) ───
// Real paid sessions, one server at a time, through the app's own connect and
// disconnect (F20.1), never while the user's VPN is on (F20.2). The caller confirms
// a spend cap first (F20.3). Each server: connect time, exit IP = server, DNS, speed
// against the direct baseline (F20.4) → FAST / SLOW / FAIL (F20.5). Every outcome,
// error and Stop moves the progress (F20.7). Deposits opened by the test are settled
// at the end; one the user already had with that server is left alone.
// History: <data>/node-tests/latest.json, history/<id>.json, failures.log (F20.6).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import type { Result } from '../../shared/types';
import {
  MAX_NODES_PER_RUN, runEstimate, runIdFor, testBasis, uriIp, verdictFor,
  type NodeTestCheck, type NodeTestProgress, type NodeTestResult, type NodeTestRun,
} from '../../core/nodetest/nodetest';
import { discoverNode } from '../../core/nodes/discovery';
import { publicIp, speedTest } from '../../core/quality/quality';
import { channelsByOwner } from '../../core/chain/accounts';
import { CHANNEL_STATUS_OPEN } from '../../core/chain/idl';
import { tdvpn } from '../../core/chain/amounts';
import { connect, disconnect } from './connection';
import { readSettlements, runSettlement } from './settlement';
import { ownerAddress } from '../wallet/vault';
import { snapshot } from '../app-state';
import { storePath } from '../store';
import { log } from '../logger';
import { isAndroid } from '../platform/android-bridge';

let running: NodeTestRun | null = null;
let stopRequested = false;

/** Thrown between the steps of one server when Stop was pressed (I7: Stop works mid-server). */
class StopAsked extends Error { constructor() { super('Stopped during this server.'); } }

const dir = (): string => storePath('node-tests');

function save(run: NodeTestRun): void {
  const d = dir();
  fs.mkdirSync(path.join(d, 'history'), { recursive: true });
  const body = JSON.stringify(run, null, 2) + '\n';
  for (const f of [path.join(d, 'latest.json'), path.join(d, 'history', `${run.id}.json`)]) {
    fs.writeFileSync(`${f}.tmp`, body, 'utf8');
    fs.renameSync(`${f}.tmp`, f);
  }
}

function logFailure(r: NodeTestResult): void {
  const line = `${new Date(r.endedAt).toISOString()} ${r.node} ${r.service} ${r.verdict} ${r.reason.replace(/\s+/g, ' ')}\n`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.appendFileSync(path.join(dir(), 'failures.log'), line, 'utf8');
}

async function openChannels(owner: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of await channelsByOwner(owner)) if (Number(c.status) === CHANNEL_STATUS_OPEN) out.add(String(c.address));
  return out;
}

async function dnsWorks(): Promise<boolean> {
  try {
    await dns.promises.lookup(`node-test-${Date.now()}.example.com`).catch((err: NodeJS.ErrnoException) => {
      // NXDOMAIN is an answer: the resolver was reached.
      if (err.code !== 'ENOTFOUND') throw err;
    });
    await dns.promises.lookup('www.wikipedia.org');
    return true;
  } catch (err) {
    log.warn('node test: dns lookup failed', { err: (err as Error).message });
    return false;
  }
}

export function nodeTestRunning(): NodeTestRun | null { return running; }

/** Stop at the next step (the server being tested is disconnected first). Also a marker file, so `test stop` in another terminal reaches a CLI run. */
export function stopNodeTest(): boolean {
  stopRequested = true;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(stopFile(), String(Date.now()), 'utf8');
  return running !== null;
}

const stopFile = (): string => path.join(dir(), 'stop');
const stopAsked = (): boolean => stopRequested || fs.existsSync(stopFile());
const clearStop = (): void => { stopRequested = false; fs.rmSync(stopFile(), { force: true }); };

export function listRuns(): Array<Pick<NodeTestRun, 'id' | 'startedAt' | 'endedAt' | 'total' | 'done' | 'stopped'> & { fast: number; slow: number; fail: number }> {
  const h = path.join(dir(), 'history');
  if (!fs.existsSync(h)) return [];
  const runs: NodeTestRun[] = [];
  for (const f of fs.readdirSync(h).filter((x) => x.endsWith('.json')).sort().reverse().slice(0, 50)) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(h, f), 'utf8')) as NodeTestRun);
    } catch (err) {
      log.warn('node test history file unreadable', { f, err: (err as Error).message });
    }
  }
  return runs.map((r) => ({
    id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, total: r.total, done: r.done, stopped: r.stopped,
    fast: r.results.filter((x) => x.verdict === 'FAST').length,
    slow: r.results.filter((x) => x.verdict === 'SLOW').length,
    fail: r.results.filter((x) => x.verdict === 'FAIL').length,
  }));
}

export function getRun(id?: string): NodeTestRun | null {
  const f = id ? path.join(dir(), 'history', `${id.replace(/[^0-9A-Za-z-]/g, '')}.json`) : path.join(dir(), 'latest.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as NodeTestRun;
}

/** What a run would cost at most, before the user confirms (F20.3). */
export async function planNodeTest(nodes: string[]): Promise<Result<{ nodes: number; estimate: string; estimateText: string; unknown: string[] }>> {
  if (!nodes.length) return { ok: false, error: 'Pick at least one server.', code: 'no-nodes' };
  if (nodes.length > MAX_NODES_PER_RUN) return { ok: false, error: `At most ${MAX_NODES_PER_RUN} servers per run.`, code: 'too-many' };
  const recs = await Promise.all(nodes.map((n) => discoverNode(n)));
  const unknown = nodes.filter((_n, i) => !recs[i]);
  const est = runEstimate(recs.filter((r): r is NonNullable<typeof r> => !!r));
  return { ok: true, data: { nodes: nodes.length, estimate: est.toString(), estimateText: `${tdvpn(est)} tDVPN`, unknown } };
}

export async function runNodeTest(
  req: { nodes: string[]; maxSpend: string; confirmed: true },
  onProgress: (p: NodeTestProgress) => void = () => undefined,
): Promise<Result<NodeTestRun>> {
  req = { ...req, nodes: [...new Set(req.nodes)] }; // a server named twice is tested once (UX12)
  if (req.confirmed !== true) return { ok: false, error: 'Confirm the spend limit first.', code: 'not-confirmed' };
  if (running) return { ok: false, error: 'A test run is already going.', code: 'busy' };
  if (snapshot().session) return { ok: false, error: 'Disconnect first: a test uses the VPN service, which runs one session at a time.', code: 'vpn-active' };
  const owner = ownerAddress();
  if (!owner) return { ok: false, error: 'Set up a wallet first.', code: 'no-wallet' };
  const plan = await planNodeTest(req.nodes);
  if (!plan.ok || !plan.data) return { ok: false, error: plan.error, code: plan.code };
  if (BigInt(plan.data.estimate) > BigInt(req.maxSpend || '0')) {
    return { ok: false, error: `These servers can lock up to ${plan.data.estimateText} in deposits, over your limit of ${tdvpn(req.maxSpend)} tDVPN. Raise the limit or pick fewer servers.`, code: 'over-limit' };
  }

  const t0 = Date.now();
  const run: NodeTestRun = {
    id: runIdFor(t0), startedAt: t0, endedAt: null, baselineMbps: null, maxSpend: req.maxSpend,
    estimatedSpend: plan.data.estimate, total: req.nodes.length, done: 0, stopped: false, results: [],
  };
  running = run;
  clearStop();
  const progress = (index: number, node: string, step: string): void => onProgress({ runId: run.id, index, total: run.total, node, step, done: run.done });

  const before = await openChannels(owner).catch((err: Error) => { log.warn('node test: channel list failed', { err: err.message }); return new Set<string>(); });
  const opened: string[] = [];
  try {
    progress(0, '', 'Measuring your speed without VPN…');
    const base = await speedTest(20_000);
    run.baselineMbps = 'mbps' in base ? base.mbps : null;
    save(run);

    for (let i = 0; i < req.nodes.length; i++) {
      const address = req.nodes[i];
      const started = Date.now();
      const checks: NodeTestCheck[] = [];
      const result: NodeTestResult = {
        node: address, service: '', country: '', verdict: 'FAIL', reason: '', basis: 'per_hour', connectMs: null,
        exitIp: null, expectedIp: null, mbps: null, checks, channel: null, error: null, startedAt: started, endedAt: started,
      };
      if (stopAsked()) {
        result.verdict = 'CANCELLED';
        result.reason = 'Stopped before this server.';
      } else {
        try {
          const halt = (): void => { if (stopAsked()) throw new StopAsked(); };
          progress(i, address, 'Checking the server…');
          const rec = await discoverNode(address);
          if (!rec) throw new Error('That server is not on the network any more.');
          result.country = rec.country;
          result.service = rec.protocolNames[0] ?? '';
          result.expectedIp = uriIp(rec.uri);
          const basis = testBasis(rec);
          if (!basis) throw new Error('This server sells neither per GB nor per hour.');
          result.basis = basis;
          halt();
          progress(i, address, 'Connecting…');
          const c0 = Date.now();
          const r = await connect({ node: address, basis, units: 1, confirmed: true });
          if (!r.ok || !r.data) throw new Error(r.error ?? 'Could not connect.');
          result.connectMs = Date.now() - c0;
          result.service = r.data.service || result.service;
          result.channel = r.data.channel || null;
          if (result.channel && !before.has(result.channel)) opened.push(result.channel);
          checks.push({ name: 'connect', ok: true, detail: `${Math.round(result.connectMs / 100) / 10} s` });
          halt();
          // Android: every protocol is inside the VPN and checks go through dvpnd's tunnel probe;
          // there is no desktop SOCKS port to dial (grid F20: V2Ray "ECONNREFUSED 127.0.0.1:1080").
          const socks = isAndroid() ? undefined : r.data.proxyEndpoint || undefined;
          await new Promise((res) => setTimeout(res, 2000));
          progress(i, address, 'Checking the exit address…');
          let ip = await publicIp(8000, socks);
          // The probe answers "no session" for a moment after connect on Android and the check then
          // runs direct (grid F20: WireGuard/AmneziaWG/OpenVPN showed the phone's own IP). Give it
          // up to 10 s more; a wrong exit after that still fails.
          for (let n = 0; isAndroid() && result.expectedIp && !('ip' in ip && ip.ip === result.expectedIp) && n < 5; n++) {
            await new Promise((res) => setTimeout(res, 2000));
            ip = await publicIp(8000, socks);
          }
          result.exitIp = 'ip' in ip ? ip.ip : null;
          const exitOk = result.exitIp ? (result.expectedIp ? result.exitIp === result.expectedIp : true) : false;
          checks.push({ name: 'exit IP', ok: exitOk, detail: result.exitIp ? `${result.exitIp}${result.expectedIp && !exitOk ? ` (server is ${result.expectedIp})` : ''}` : ('error' in ip ? ip.error : 'none') });
          if (!socks) {
            const dnsOk = await dnsWorks();
            checks.push({ name: 'DNS', ok: dnsOk, detail: dnsOk ? `resolver ${snapshot().dns ?? 'system'}` : 'names did not resolve' });
          } else {
            checks.push({ name: 'DNS', ok: !!result.exitIp, detail: 'resolved at the VPN exit (SOCKS)' });
          }
          halt();
          progress(i, address, 'Speed test…');
          const sp = await speedTest(30_000, socks);
          result.mbps = 'mbps' in sp ? sp.mbps : null;
          checks.push({ name: 'speed', ok: result.mbps !== null, detail: 'mbps' in sp ? `${sp.mbps} Mbps (${sp.source})` : sp.error });
          const v = verdictFor({ connected: true, exitOk, mbps: result.mbps }, run.baselineMbps);
          result.verdict = v.verdict;
          result.reason = v.reason;
        } catch (err) {
          if (err instanceof StopAsked) {
            result.verdict = 'CANCELLED';
            result.reason = err.message;
          } else {
            result.error = (err as Error).message;
            const v = verdictFor({ connected: result.connectMs !== null, exitOk: null, mbps: null, error: result.error }, run.baselineMbps);
            result.verdict = v.verdict;
            result.reason = v.reason;
          }
        } finally {
          if (snapshot().session) {
            progress(i, address, 'Disconnecting…');
            const d = await disconnect();
            if (!d.ok) checks.push({ name: 'disconnect', ok: false, detail: d.error ?? 'failed' });
          }
        }
      }
      result.endedAt = Date.now();
      run.results.push(result);
      run.done = i + 1;
      if (result.verdict === 'FAIL') logFailure(result);
      save(run);
      progress(i, address, `${result.verdict}: ${result.reason}`);
    }
    run.stopped = stopAsked();
  } finally {
    run.endedAt = Date.now();
    save(run);
    running = null;
    clearStop();
    if (opened.length) {
      progress(run.total, '', 'Closing the test deposits…');
      await settleOpened(opened);
    }
  }
  return { ok: true, data: run };
}

/**
 * Per-hour deposits close in two steps that can follow at once (start close, then close);
 * a per-GB one starts its 2 h grace here and finishes later in Settlements. Disconnect also
 * queues an auto-settle 15 s later, so a "busy" answer just means wait and look again.
 */
async function settleOpened(opened: string[]): Promise<void> {
  const pause = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
  await pause(20_000);
  for (let pass = 0; pass < 5; pass++) {
    const pending = (await readSettlements()).filter((p) => opened.includes(p.channel) && (p.status === 'open' || p.status === 'ready'));
    if (!pending.length) return;
    const r = await runSettlement(pending.map((p) => p.channel));
    if (!r.ok && r.code !== 'busy') log.warn('node test: settlement pass failed', { pass, err: r.error });
    await pause(8_000);
  }
  log.warn('node test: some test deposits are still open; Settlements will finish them', { opened });
}
