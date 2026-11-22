import { describe, it, expect } from 'vitest';
import type { HabitItemView, HabitTodayRow, PerWeekProgress } from '@dashboard/shared';
import { buildHabitTree } from './tree';
import { isDayComplete, isStreakMilestone, shouldFireDayBurst, STREAK_MILESTONES } from './completion-feedback';

/**
 * The completion-feedback decision logic (T889). The visual layers are CSS; these pure functions
 * decide *when* the whole-day burst may play and which streaks earn a flourish.
 */

let nextId = 1;
function item(name: string, parentId: number | null): HabitItemView {
  return {
    id: nextId++,
    parentId,
    kind: 'habit',
    metricType: null,
    name,
    sortOrder: 0,
    archivedAt: null,
    createdAt: 0,
    completionCount: 0,
  };
}

function row(it: HabitItemView, opts: { due?: boolean; perWeek?: PerWeekProgress | null } = {}): HabitTodayRow {
  return {
    item: it,
    schedule: null,
    due: opts.due ?? true,
    completedToday: false,
    perWeek: opts.perWeek ?? null,
    streak: { current: 0, longest: 0 },
    isSet: false,
    progress: null,
  };
}

describe('isStreakMilestone', () => {
  it('is true only at 7, 30, 100, 365', () => {
    for (const n of STREAK_MILESTONES) expect(isStreakMilestone(n)).toBe(true);
    for (const n of [0, 1, 2, 6, 8, 29, 31, 99, 101, 364, 366]) expect(isStreakMilestone(n)).toBe(false);
  });
});

describe('isDayComplete', () => {
  it('is false when nothing is due', () => {
    const a = item('a', null);
    const tree = buildHabitTree([row(a, { due: false })], new Set());
    expect(isDayComplete(tree)).toBe(false);
  });

  it('is false while any due leaf is outstanding, true once all are done', () => {
    const a = item('a', null);
    const b = item('b', null);
    const rows = [row(a), row(b)];
    expect(isDayComplete(buildHabitTree(rows, new Set([a.id])))).toBe(false);
    expect(isDayComplete(buildHabitTree(rows, new Set([a.id, b.id])))).toBe(true);
  });

  it('ignores not-due leaves', () => {
    const a = item('a', null);
    const b = item('b', null); // not due today
    const rows = [row(a), row(b, { due: false })];
    expect(isDayComplete(buildHabitTree(rows, new Set([a.id])))).toBe(true);
  });

  it('counts a per-week leaf as done when its weekly target is met, without a tick today', () => {
    const a = item('a', null);
    const rows = [row(a, { perWeek: { count: 3, target: 3, met: true } })];
    expect(isDayComplete(buildHabitTree(rows, new Set()))).toBe(true);
  });

  it('counts a set only through its leaves', () => {
    const parent = item('set', null);
    const child = item('child', parent.id);
    const rows = [row(parent), row(child)];
    // child outstanding → not complete; child done → complete (set derives from the leaf)
    expect(isDayComplete(buildHabitTree(rows, new Set()))).toBe(false);
    expect(isDayComplete(buildHabitTree(rows, new Set([child.id])))).toBe(true);
  });
});

describe('shouldFireDayBurst', () => {
  it('fires when complete and not yet fired for this day', () => {
    expect(shouldFireDayBurst('2026-11-22', true, null)).toBe(true);
  });

  it('does not fire when the day is not complete', () => {
    expect(shouldFireDayBurst('2026-11-22', false, null)).toBe(false);
  });

  it('does not replay after untick + re-tick on the same day', () => {
    const day = '2026-11-22';
    // First completion fires and the caller records the day…
    expect(shouldFireDayBurst(day, true, null)).toBe(true);
    const lastFired = day;
    // Untick: complete flips false — nothing fires.
    expect(shouldFireDayBurst(day, false, lastFired)).toBe(false);
    // Re-tick: complete true again, but already fired for this day → still silent.
    expect(shouldFireDayBurst(day, true, lastFired)).toBe(false);
  });

  it('is eligible again on a new habit day', () => {
    expect(shouldFireDayBurst('2026-11-23', true, '2026-11-22')).toBe(true);
  });
});
