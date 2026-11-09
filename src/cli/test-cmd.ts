// ─── `test` — in-app node testing from the CLI (F20) ───
// Same service as the app's Node test screen. `run` prints one line per step and a
// verdict per server; Ctrl-C stops it between servers (the current one finishes and
// disconnects first, so the network is never left mid-session).
import { consoleText } from './console-text';
import fs from 'node:fs';
import type { Args } from './args';
import { flag, str, whole, UsageError } from './args';
import { confirm, type Out } from './commands';
import { refreshNodes } from '../main/services/nodes';
import { adoptRunningSession } from '../main/services/connection';
import { planNodeTest, runNodeTest, stopNodeTest, listRuns, getRun } from '../main/services/node-test';
import { compareRuns, runSummary, MAX_NODES_PER_RUN, type NodeTestRun } from '../core/nodetest/nodetest';
import { toBaseUnits } from '../core/chain/amounts';

const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

async function pickNodes(a: Args): Promise<string[]> {
  const listed = a._.slice(2);
  if (listed.length) return listed;
  if (!flag(a, 'online')) throw new UsageError('test run <node…> | --online');
  const online = (await refreshNodes({ probe: true })).filter((n) => n.listingFresh && n.probe?.ok);
  return online.slice(0, whole(a, 'max-nodes', MAX_NODES_PER_RUN, 1, MAX_NODES_PER_RUN)).map((n) => n.address);
}

function runLines(run: NodeTestRun): string {
  const s = runSummary(run);
  const head = `Run ${run.id}  ${run.done}/${run.total}${run.stopped ? ' (stopped)' : ''}  FAST ${s.FAST}  SLOW ${s.SLOW}  FAIL ${s.FAIL}${run.baselineMbps ? `  without VPN ${run.baselineMbps} Mbps` : ''}`;
  const rows = run.results.map((r) => `${r.verdict.padEnd(9)} ${short(r.node)}  ${(r.service || '?').padEnd(10)} ${(r.country || '').padEnd(15)} ${r.reason}${r.checks.length ? `\n          ${r.checks.map((c) => `${c.ok ? 'ok' : 'x'} ${c.name} ${c.detail}`).join(' · ')}` : ''}`);
  return [head, ...rows].join('\n');
}

export async function testCmd(a: Args, o: Out): Promise<void> {
  const sub = a._[1] ?? 'history';
  if (sub === 'plan' || sub === 'run') {
    const nodes = await pickNodes(a);
    const plan = await planNodeTest(nodes);
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? 'Could not plan the run.');
    if (sub === 'plan') {
      o.print(`${nodes.length} server${nodes.length === 1 ? '' : 's'}: up to ${plan.data.estimateText} in deposits (per-hour ones close right after).${plan.data.unknown.length ? `\nNot on the network: ${plan.data.unknown.join(', ')}` : ''}`, plan.data);
      return;
    }
    const maxSpend = str(a, 'max-spend') ? toBaseUnits(str(a, 'max-spend')!) : plan.data.estimate;
    confirm(a, o, `Test ${nodes.length} server${nodes.length === 1 ? '' : 's'}, one real session each: up to ${plan.data.estimateText} locked in deposits, the unused part comes back when they close.`, plan.data);
    await adoptRunningSession();
    const onStop = (): void => { stopNodeTest(); process.stderr.write(consoleText('\nStopping after this server…\n', process.stderr)); };
    process.once('SIGINT', onStop);
    try {
      const r = await runNodeTest({ nodes, maxSpend, confirmed: true }, (p) => {
        if (!o.json) process.stdout.write(consoleText(`[${Math.min(p.index + 1, p.total)}/${p.total}] ${p.node ? short(p.node) + ' ' : ''}${p.step}\n`));
      });
      if (!r.ok || !r.data) throw Object.assign(new Error(r.error ?? 'Test run failed.'), { code: r.code });
      o.print(runLines(r.data), r.data);
    } finally {
      process.removeListener('SIGINT', onStop);
    }
    return;
  }
  if (sub === 'stop') {
    const here = stopNodeTest();
    o.print(here ? 'Stopping after the current server.' : 'Asked any running test to stop after its current server.', { stopping: true });
    return;
  }
  if (sub === 'history') {
    const runs = listRuns();
    o.print(runs.length ? runs.map((r) => `${r.id}  ${r.done}/${r.total}${r.stopped ? ' stopped' : ''}  FAST ${r.fast}  SLOW ${r.slow}  FAIL ${r.fail}`).join('\n') : 'No test runs yet.', runs);
    return;
  }
  if (sub === 'show' || sub === 'export') {
    const run = getRun(a._[2]);
    if (!run) throw new Error(a._[2] ? `No run ${a._[2]}.` : 'No test runs yet.');
    if (sub === 'export') {
      const out = str(a, 'out');
      const body = JSON.stringify(run, null, 2) + '\n';
      if (out) { fs.writeFileSync(out, body, 'utf8'); o.print(`Wrote ${out}`, { file: out }); } else o.print(body.trimEnd(), run);
      return;
    }
    let text = runLines(run);
    if (flag(a, 'compare')) {
      const prevId = listRuns().map((r) => r.id).find((id) => id < run.id);
      const prev = prevId ? getRun(prevId) : null;
      const diff = prev ? compareRuns(prev, run) : [];
      text += prev ? `\nSince ${prev.id}: ${diff.length ? diff.map((d) => `${short(d.node)} ${d.before} → ${d.after}`).join(', ') : 'no verdict changed'}` : '\nNo earlier run to compare with.';
    }
    o.print(text, run);
    return;
  }
  throw new UsageError(`unknown: test ${sub}`);
}
