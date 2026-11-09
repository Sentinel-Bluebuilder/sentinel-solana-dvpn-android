// ─── Q0317: an open confirm dialog survives its data reloading ───
// and2 onboard: "Review and sign", then Sign, and the dialog was gone at +4 s with no tx and no
// message. PermissionStep rendered `open && plan && <ConfirmModal>`; the plan reloads on every
// balance change, and a failed reload set plan = null silently, which removed the open dialog.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialPlanDialog, planDialog, type PlanDialog, type PlanEvent } from '../../src/shared/plan-dialog';

type Plan = { steps: string[] };
const run = (events: PlanEvent<Plan>[]): PlanDialog<Plan> => events.reduce(planDialog<Plan>, initialPlanDialog<Plan>());
const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('confirm dialog over a reloading plan (Q0317)', () => {
  const first: Plan = { steps: ['Spending limit 50 tDVPN', 'Send 0.01 SOL to the device'] };

  it('dialog open, balance changes, the reload fails: the dialog stays with the plan it opened with', () => {
    const s = run([{ type: 'loaded', plan: first }, { type: 'open' }, { type: 'failed', error: 'RPC busy' }]);
    expect(s.open).toEqual(first);
    expect(s.plan).toBeNull();
    expect(s.error).toBe('RPC busy');
  });

  it('a successful reload while open does not change what the open dialog shows', () => {
    const s = run([{ type: 'loaded', plan: first }, { type: 'open' }, { type: 'loaded', plan: { steps: ['other'] } }]);
    expect(s.open).toEqual(first);
  });

  it('a failed load is an error the screen shows, and the next good load clears it', () => {
    expect(run([{ type: 'failed', error: 'RPC busy' }]).error).toBe('RPC busy');
    expect(run([{ type: 'failed', error: 'RPC busy' }, { type: 'loaded', plan: first }]).error).toBe('');
  });

  it('no plan, no dialog; close closes it', () => {
    expect(run([{ type: 'open' }]).open).toBeNull();
    expect(run([{ type: 'loaded', plan: first }, { type: 'open' }, { type: 'close' }]).open).toBeNull();
  });
});

describe('wiring: no open dialog is gated on data that reloads (Q0317 sweep)', () => {
  it('device permission step renders its dialog from the frozen plan and shows load errors', () => {
    const src = read('src/renderer/src/screens/Onboarding.tsx');
    expect(src).not.toMatch(/\{open && plan && \(/);
    expect(src).toMatch(/\{dlg\.open && \(\s*<ConfirmModal\s+title="Sign device permission"\s+lines=\{\[\.\.\.dlg\.open\.steps/);
    expect(src).toMatch(/dispatch\(\{ type: 'failed', error:/);
    expect(src).toMatch(/data-plan-error/);
  });

  it('node test dialog holds its own plan copy', () => {
    const src = read('src/renderer/src/screens/NodeTest.tsx');
    expect(src).not.toMatch(/\{confirm && plan && \(/);
    expect(src).toMatch(/onClick=\{\(\) => setConfirm\(plan\)\}/);
    expect(src).not.toMatch(/\(\) => setPlan\(null\)\)/);
  });
});
