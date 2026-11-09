// Q0313 root cause: DRIVERS_REPAIR's report ({ ok, error, view }) must reach Diagnostics as data.
// Returned bare, call() took it for the IPC Result: undefined on success, a throw on failure.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Result<T> = { ok: boolean; data?: T; error?: string };

// The renderer's call() contract, as in src/renderer/src/lib/store.ts.
function callShape<T>(r: unknown): T {
  if (r && typeof r === 'object' && 'ok' in (r as object)) {
    const res = r as Result<T>;
    if (!res.ok) throw new Error(res.error ?? 'failed');
    return res.data as T;
  }
  return r as T;
}

// The main process wrapper: an object with ok passes through, anything else is wrapped.
const wrapShape = (out: unknown): unknown => (out && typeof out === 'object' && 'ok' in (out as object) ? out : { ok: true, data: out });
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

describe('DRIVERS_REPAIR reaches Diagnostics as data', () => {
  it('the handler wraps the report with ok()', () => {
    expect(readFileSync('src/main/ipc.ts', 'utf8')).toMatch(/\[IPC\.DRIVERS_REPAIR\]: async \(\) => ok\(await repairDrivers\(\)\)/);
  });

  it('wrapped: a good repair gives the view, a failed one gives its error (not a throw)', () => {
    const good = callShape<{ ok: boolean; view: string }>(wrapShape(ok({ ok: true, view: 'v' })));
    expect(good).toEqual({ ok: true, view: 'v' });
    const bad = callShape<{ ok: boolean; error: string }>(wrapShape(ok({ ok: false, error: 'cancelled', view: 'v' })));
    expect(bad.error).toBe('cancelled');
  });

  it('negative control: bare, the success report is lost and the failure throws', () => {
    expect(callShape(wrapShape({ ok: true, view: 'v' }))).toBeUndefined();
    expect(() => callShape(wrapShape({ ok: false, error: 'cancelled', view: 'v' }))).toThrow('cancelled');
  });
});
