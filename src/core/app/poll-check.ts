// ─── Cadence check for "poll watch" (F5 proof) ───
// Given the job runs seen in a window, did each job keep to its cadence?
//   - never more often than its interval (minus one scheduler tick of slack)
//   - at least once if it is due in the window (it runs at start)
//   - not at all while hidden, unless it is allowed to run hidden

export interface CadenceJob { name: string; everyMs: number; whenHidden: boolean }
export interface CadenceRun { name: string; at: number }
export interface CadenceResult { name: string; runs: number; maxRuns: number; minGapMs: number | null; ok: boolean; why: string }

export function checkCadence(jobs: CadenceJob[], runs: CadenceRun[], windowMs: number, hidden: boolean, tickMs = 1000, skip: string[] = []): CadenceResult[] {
  return jobs.map((j) => {
    const at = runs.filter((r) => r.name === j.name).map((r) => r.at).sort((a, b) => a - b);
    let minGap: number | null = null;
    for (let i = 1; i < at.length; i++) minGap = Math.min(minGap ?? Infinity, at[i] - at[i - 1]);
    const maxRuns = Math.floor(windowMs / j.everyMs) + 1;
    const base = { name: j.name, runs: at.length, maxRuns, minGapMs: minGap };
    if (hidden && !j.whenHidden) return { ...base, ok: at.length === 0, why: at.length ? 'ran while hidden' : 'paused while hidden' };
    if (minGap !== null && minGap < j.everyMs - tickMs) return { ...base, ok: false, why: `ran ${minGap} ms apart, cadence ${j.everyMs} ms` };
    if (at.length > maxRuns) return { ...base, ok: false, why: `ran ${at.length} times, at most ${maxRuns} expected` };
    // Some jobs skip on purpose (nodes: the list on disk is still fresh); those may not run.
    if (at.length === 0 && !skip.includes(j.name)) return { ...base, ok: false, why: 'never ran' };
    return { ...base, ok: true, why: at.length ? 'on cadence' : 'skipped (data still fresh)' };
  });
}
