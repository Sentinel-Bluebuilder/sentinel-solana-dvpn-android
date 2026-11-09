// ─── "Checking the connection…" while StartSession runs (Q0357) ───
// dvpnd answers StartSession only after its tunnel check, which can take up to ~13 s on a bad path.
// Meanwhile it lists the session with status "checking". This polls the list while the start is
// pending and reports once when the check begins, so the screen says what is happening instead
// of a frozen "Connecting…".

export interface CheckingWatchDeps {
  listSessions: () => Promise<Array<{ status: string }>>;
  onChecking: () => void;
  everyMs?: number;
}

/**
 * A connect started elsewhere (the CLI) is found by the idle session poll. While dvpnd lists it as
 * "checking", the app shows "Checking the connection…" without adopting it (no session to follow
 * yet); once it is live it is adopted as usual, and if the check failed (nothing listed) the
 * label goes back to idle. `showing` = the app currently shows such an outside check.
 */
export type OutsideCheck = 'show' | 'keep' | 'clear' | 'adopt' | 'none';
export function outsideCheck(running: { status: string } | undefined, showing: boolean): OutsideCheck {
  if (running?.status === 'checking') return showing ? 'keep' : 'show';
  if (running) return 'adopt';
  return showing ? 'clear' : 'none';
}

/** Runs `start`, calling onChecking once if dvpnd reports a session in its tunnel check before start settles. */
export async function withCheckingWatch<T>(start: Promise<T>, deps: CheckingWatchDeps): Promise<T> {
  let done = false;
  let shown = false;
  const tick = async (): Promise<void> => {
    if (done || shown) return;
    let list: Array<{ status: string }>;
    try {
      list = await deps.listSessions();
    } catch (err) {
      // A missed poll only delays the label; the start itself decides the outcome.
      console.warn('checking watch: listing sessions failed', (err as Error).message);
      return;
    }
    if (done || shown) return; // the start settled while we asked: its result owns the view
    if (list.some((s) => s.status === 'checking')) {
      shown = true;
      deps.onChecking();
    }
  };
  const timer = setInterval(() => { void tick(); }, deps.everyMs ?? 1000);
  try {
    return await start;
  } finally {
    done = true;
    clearInterval(timer);
  }
}
