import { describe, it, expect } from 'vitest';
import { epicRefinementDisplay } from '@dashboard/shared';

// T979 (D-089, D-103). `epicRefinementDisplay` lives in packages/shared; it is tested here, beside
// `queue-blockers.spec.ts`, because packages/shared has no test runner of its own. It is the
// DISPLAY composite — the stored `refined` / `refine_stale` columns are unchanged.

const epic = (refined: boolean, refineStale = false) => ({ id: 10, refined, refineStale });
const member = (
  id: number,
  refined: boolean,
  status: 'backlog' | 'queue' | 'completed' | 'closed' = 'backlog',
) => ({ id, refined, status });

describe('epicRefinementDisplay (T979)', () => {
  it('fully-refined — Epic refined, not stale, every open member refined', () => {
    const d = epicRefinementDisplay(epic(true), [member(1, true), member(2, true)]);
    expect(d).toEqual({ state: 'fully-refined', label: 'Fully refined', refinedCount: 2, openCount: 2 });
  });

  it('fully-refined — an Epic with no open members, when refined', () => {
    const d = epicRefinementDisplay(epic(true), []);
    expect(d).toEqual({ state: 'fully-refined', label: 'Fully refined', refinedCount: 0, openCount: 0 });
  });

  it('fully-refined — terminal members are ignored (all remaining open members refined)', () => {
    const d = epicRefinementDisplay(epic(true), [
      member(1, true),
      member(2, false, 'completed'),
      member(3, false, 'closed'),
    ]);
    expect(d).toEqual({ state: 'fully-refined', label: 'Fully refined', refinedCount: 1, openCount: 1 });
  });

  it('plan-refined — Epic refined but some open member unrefined (N/M tally)', () => {
    const d = epicRefinementDisplay(epic(true), [member(1, true), member(2, false)]);
    expect(d).toEqual({
      state: 'plan-refined',
      label: 'Plan refined · 1/2 members',
      refinedCount: 1,
      openCount: 2,
    });
  });

  it('plan-refined — PD-555 renders "Plan refined · 1/2 members"', () => {
    // The Backup verification Epic: refined, two members, PD-553 unrefined.
    const d = epicRefinementDisplay(epic(true), [member(553, false), member(554, true)]);
    expect(d.state).toBe('plan-refined');
    expect(d.label).toBe('Plan refined · 1/2 members');
  });

  it('plan-refined — terminal members excluded from both the tally and the count', () => {
    const d = epicRefinementDisplay(epic(true), [
      member(1, true),
      member(2, false),
      member(3, false, 'completed'),
    ]);
    expect(d).toEqual({
      state: 'plan-refined',
      label: 'Plan refined · 1/2 members',
      refinedCount: 1,
      openCount: 2,
    });
  });

  it('stale — unchanged label, regardless of members; wins over the refined branches', () => {
    const d = epicRefinementDisplay(epic(false, true), [member(1, true)]);
    expect(d.state).toBe('stale');
    expect(d.label).toBe('⚠ Stale');
  });

  it('stale — even if `refined` is somehow still set, staleness wins', () => {
    const d = epicRefinementDisplay(epic(true, true), [member(1, true)]);
    expect(d.state).toBe('stale');
  });

  it('not-refined — never refined, not stale', () => {
    const d = epicRefinementDisplay(epic(false), [member(1, false)]);
    expect(d.state).toBe('not-refined');
    expect(d.label).toBe('Not refined');
  });
});
