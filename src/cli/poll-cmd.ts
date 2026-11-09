// ─── `poll` — background refresh cadences (F5) from the CLI ───
// show / set / reset change the same `poll` setting as the Settings screen. `run` runs one
// job now; `watch` runs the real scheduler for N seconds and checks every job kept to its
// cadence (exit 1 if not), the end-to-end proof of polling.
import type { Args } from './args';
import { flag, whole, UsageError } from './args';
import type { Out } from './commands';
import { getSettings, updateSettings } from '../main/system/settings';
import { POLL_JOBS, POLL_JOB_NAMES, DEFAULT_POLL, validPoll, type PollJob } from '../shared/poll';
import { startScheduler, stopScheduler, setHidden, onJobRun, jobInfo, runJobNow, type JobRun } from '../main/scheduler';
import { checkCadence } from '../core/app/poll-check';

function table(): string {
  const p = getSettings().poll;
  return POLL_JOB_NAMES.map((k) => {
    const j = POLL_JOBS[k];
    return `${k.padEnd(14)} ${String(p[k]).padStart(5)} s   default ${String(j.def).padStart(4)}   range ${j.min}-${j.max}   ${j.label}`;
  }).join('\n');
}

function jobName(s: string): PollJob {
  if (!(s in POLL_JOBS)) throw new UsageError(`unknown job "${s}". Jobs: ${POLL_JOB_NAMES.join(', ')}`);
  return s as PollJob;
}

const clock = (t: number): string => new Date(t).toISOString().slice(11, 19);

export async function pollCmd(a: Args, o: Out): Promise<void> {
  const sub = a._[1] ?? 'show';
  if (sub === 'show') {
    o.print(table(), getSettings().poll);
  } else if (sub === 'set') {
    const pairs = a._.slice(2);
    if (!pairs.length) throw new UsageError('poll set <job>=<seconds> …');
    const next = { ...getSettings().poll };
    for (const kv of pairs) {
      const [k, v] = kv.split('=');
      const job = jobName(k);
      const n = validPoll(job, v);
      if (n === null) throw new UsageError(`${job} must be a whole number of seconds from ${POLL_JOBS[job].min} to ${POLL_JOBS[job].max}`);
      next[job] = n;
    }
    updateSettings({ poll: next });
    o.print(table(), getSettings().poll);
  } else if (sub === 'reset') {
    const names = a._.slice(2).map(jobName);
    const next = { ...getSettings().poll };
    for (const k of names.length ? names : POLL_JOB_NAMES) next[k] = DEFAULT_POLL[k];
    updateSettings({ poll: next });
    o.print(table(), getSettings().poll);
  } else if (sub === 'run') {
    const names = a._.slice(2).map(jobName);
    const runs: JobRun[] = [];
    for (const k of names.length ? names : POLL_JOB_NAMES.filter((n) => n !== 'session')) runs.push(await runJobNow(k));
    o.print(runs.map((r) => `${r.name.padEnd(14)} ${r.ok ? 'ok ' : 'ERR'} ${String(r.ms).padStart(6)} ms${r.error ? `  ${r.error}` : ''}`).join('\n'), runs);
    if (runs.some((r) => !r.ok)) throw new Error(`${runs.filter((r) => !r.ok).map((r) => r.name).join(', ')} failed.`);
  } else if (sub === 'watch') {
    const seconds = whole(a, 'seconds', 75, 10, 3600);
    const hidden = flag(a, 'hidden');
    const runs: JobRun[] = [];
    const off = onJobRun((r) => {
      runs.push(r);
      o.print(`${clock(r.at)}  ${r.name.padEnd(14)} ${r.ok ? 'ok ' : 'ERR'} ${String(r.ms).padStart(6)} ms${r.error ? `  ${r.error}` : ''}`);
    });
    const start = Date.now();
    setHidden(hidden);
    startScheduler();
    await new Promise((res) => setTimeout(res, seconds * 1000));
    stopScheduler();
    off();
    setHidden(false);
    // ip runs only while connected (once when idle); nodes skips while its list on disk is fresh;
    // session skips when no service answers or a session is already shown (the Linux app fd44948: "runs 0/3
    // never ran" in the local tier on arm64 Debian 12).
    const jobs = jobInfo().map((j) => ({ name: j.name, everyMs: j.everyMs, whenHidden: j.whenHidden }));
    const res = checkCadence(jobs, runs.filter((r) => r.at >= start), Date.now() - start, hidden, 1000, ['nodes', 'ip', 'session']);
    o.print(['', `Cadence over ${seconds} s${hidden ? ' (window hidden)' : ''}:`, ...res.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(14)} runs ${r.runs}/${r.maxRuns}  ${r.why}`)].join('\n'), { runs, result: res });
    if (res.some((r) => !r.ok)) throw new Error('a job broke its cadence');
  } else throw new UsageError(`unknown: poll ${sub}`);
}
