import { describe, it, expect } from 'vitest';
import {
  DAYS_OF_WEEK_ALL,
  habitWeekday,
  habitWeekStart,
  addHabitDays,
  type HabitCompletion,
  type HabitItemView,
  type HabitSchedule,
} from '@dashboard/shared';
import { uncheckedYesterdayCount } from './yesterday';

/** The Today "Yesterday: N habits unchecked" count (T889). Pure, so it is unit-testable. */

const YESTERDAY = '2026-11-21';

let nextId = 1;
function item(
  name: string,
  parentId: number | null,
  overrides: Partial<HabitItemView> = {},
): HabitItemView {
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
    ...overrides,
  };
}

let nextSched = 1;
function daysOfWeek(itemId: number, mask: number): HabitSchedule {
  return { id: nextSched++, itemId, effectiveFromDay: '2000-01-01', kind: 'days_of_week', daysMask: mask, perWeekN: null };
}
function perWeek(itemId: number, n: number): HabitSchedule {
  return { id: nextSched++, itemId, effectiveFromDay: '2000-01-01', kind: 'per_week', daysMask: null, perWeekN: n };
}

function done(itemId: number, day: string): HabitCompletion {
  return { itemId, day, completedAt: 0 };
}

describe('uncheckedYesterdayCount', () => {
  it('counts a daily leaf habit left unchecked yesterday', () => {
    const a = item('a', null);
    expect(uncheckedYesterdayCount([a], [daysOfWeek(a.id, DAYS_OF_WEEK_ALL)], [], YESTERDAY)).toBe(1);
  });

  it('does not count one that was done yesterday', () => {
    const a = item('a', null);
    const count = uncheckedYesterdayCount([a], [daysOfWeek(a.id, DAYS_OF_WEEK_ALL)], [done(a.id, YESTERDAY)], YESTERDAY);
    expect(count).toBe(0);
  });

  it('does not count a habit that was not due yesterday', () => {
    const a = item('a', null);
    // A mask with every weekday *except* yesterday's → not due yesterday.
    const mask = DAYS_OF_WEEK_ALL & ~(1 << habitWeekday(YESTERDAY));
    expect(uncheckedYesterdayCount([a], [daysOfWeek(a.id, mask)], [], YESTERDAY)).toBe(0);
  });

  it('never counts metrics', () => {
    const m = item('drinks', null, { kind: 'metric', metricType: 'number' });
    expect(uncheckedYesterdayCount([m], [], [], YESTERDAY)).toBe(0);
  });

  it('never counts archived habits', () => {
    const a = item('a', null, { archivedAt: 123 });
    expect(uncheckedYesterdayCount([a], [daysOfWeek(a.id, DAYS_OF_WEEK_ALL)], [], YESTERDAY)).toBe(0);
  });

  it('counts leaves but not the set that contains them', () => {
    const set = item('Vitamins', null);
    const c1 = item('D3', set.id);
    const c2 = item('Zinc', set.id);
    const count = uncheckedYesterdayCount(
      [set, c1, c2],
      [daysOfWeek(c1.id, DAYS_OF_WEEK_ALL), daysOfWeek(c2.id, DAYS_OF_WEEK_ALL)],
      [done(c1.id, YESTERDAY)], // one child done, one not
      YESTERDAY,
    );
    expect(count).toBe(1); // only the outstanding child; the set itself is never counted
  });

  it('treats a per-week habit as checked once its weekly target is met', () => {
    const a = item('Gym', null);
    const weekStart = habitWeekStart(YESTERDAY);
    // Three completions within the habit week, none on yesterday itself.
    const week = Array.from({ length: 7 }, (_, i) => addHabitDays(weekStart, i));
    const completions = week.filter((d) => d !== YESTERDAY).slice(0, 3).map((d) => done(a.id, d));
    expect(uncheckedYesterdayCount([a], [perWeek(a.id, 3)], completions, YESTERDAY)).toBe(0);
  });

  it('counts a per-week habit still short of its target', () => {
    const a = item('Gym', null);
    expect(uncheckedYesterdayCount([a], [perWeek(a.id, 3)], [], YESTERDAY)).toBe(1);
  });
});
