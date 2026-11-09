import { describe, expect, it, vi, afterEach } from 'vitest';
import { withCheckingWatch } from '../../src/core/session/checking-watch';
import { phaseFromDaemon, viewFor } from '../../src/core/session/state';

// Q0357: while dvpnd runs its tunnel check the screen says "Checking the connection…", between
// "Connecting…" and Protected, and never Protected on the way to an error.

describe('checking phase', () => {
  it('dvpnd "checking" is its own phase, never connected', () => {
    expect(phaseFromDaemon('checking')).toBe('checking');
    expect(phaseFromDaemon('checking')).not.toBe('connected');
  });

  it('reads "Checking the connection…" and can be cancelled', () => {
    const v = viewFor('checking');
    expect(v.title).toBe('Checking the connection…');
    expect(v.canCancel).toBe(true);
    expect(v.canDisconnect).toBe(false);
  });
});

describe('withCheckingWatch', () => {
  afterEach(() => { vi.useRealTimers(); });

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('shows checking between connecting and connected', async () => {
    vi.useFakeTimers();
    const views: string[] = ['connecting'];
    let status = 'active'; // dvpnd's stored row before the check starts
    const start = deferred<string>();
    const run = withCheckingWatch(start.promise, {
      listSessions: async () => [{ status }],
      onChecking: () => views.push('checking'),
      everyMs: 1000,
    }).then((r) => { views.push('connected'); return r; });

    await vi.advanceTimersByTimeAsync(1000);
    expect(views).toEqual(['connecting']);
    status = 'checking';
    await vi.advanceTimersByTimeAsync(3000);
    expect(views).toEqual(['connecting', 'checking']); // shown once, not per poll
    start.resolve('s1');
    await expect(run).resolves.toBe('s1');
    expect(views).toEqual(['connecting', 'checking', 'connected']);
  });

  it('shows checking then the error, never connected', async () => {
    vi.useFakeTimers();
    const views: string[] = [];
    const start = deferred<string>();
    const run = withCheckingWatch(start.promise, {
      listSessions: async () => [{ status: 'checking' }],
      onChecking: () => views.push('checking'),
    }).then(() => views.push('connected'), () => views.push('error'));

    await vi.advanceTimersByTimeAsync(1000);
    start.reject(new Error('this network drops large packets'));
    await run;
    expect(views).toEqual(['checking', 'error']);
  });

  it('never shows checking after the start settled (a late poll answer is dropped)', async () => {
    vi.useFakeTimers();
    const onChecking = vi.fn();
    const answer = deferred<Array<{ status: string }>>();
    const start = deferred<string>();
    const run = withCheckingWatch(start.promise, { listSessions: () => answer.promise, onChecking });

    await vi.advanceTimersByTimeAsync(1000); // poll in flight
    start.resolve('s1');
    await run;
    answer.resolve([{ status: 'checking' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onChecking).not.toHaveBeenCalled();
  });
});
