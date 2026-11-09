// ─── A confirm dialog over data that keeps reloading (Q0317) ───
// Browser-safe. The device-permission step reloads its plan on every balance change, and the
// dialog was rendered as `open && plan && <ConfirmModal>`: one failed reload (plan = null) while
// the dialog was open removed it, with no transaction and no message. The dialog now holds the
// plan it was opened with; reloads change only what the next open shows, and a failed reload is
// an error the screen shows instead of a silent null.

export interface PlanDialog<P> {
  /** The latest plan, or null when it could not be loaded. */
  plan: P | null;
  /** Why the latest load failed ('' when it did not). */
  error: string;
  /** The plan the open dialog shows (frozen when it opened), or null when it is closed. */
  open: P | null;
}

export type PlanEvent<P> =
  | { type: 'loaded'; plan: P }
  | { type: 'failed'; error: string }
  | { type: 'open' }
  | { type: 'close' };

export function initialPlanDialog<P>(): PlanDialog<P> {
  return { plan: null, error: '', open: null };
}

export function planDialog<P>(s: PlanDialog<P>, e: PlanEvent<P>): PlanDialog<P> {
  switch (e.type) {
    case 'loaded': return { ...s, plan: e.plan, error: '' };
    case 'failed': return { ...s, plan: null, error: e.error };
    case 'open': return s.plan ? { ...s, open: s.plan } : s;
    case 'close': return { ...s, open: null };
  }
}
