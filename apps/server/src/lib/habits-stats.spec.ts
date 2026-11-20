import { describe, it, expect } from 'vitest';
import {
  completionRate,
  setCompletionRate,
  habitMonthSpans,
  habitWeeksEndingAt,
  type HabitHistoryNode,
  type HabitSchedule,
} from '@dashboard/shared';

/**
 * Pure By Habit header-stats + calendar-layout logic (PD-726). Like the schedule/streak logic
 * (`habits-schedule.spec.ts`), these live in `@dashboard/shared` and are tested here because the
 * shared package has no runner of its own.
 *
 * Anchor week: Mon 2026-11-16 … Sun 2026-11-22 (same as `habits-schedule.spec.ts`).
 * Weekday bits are Monday-indexed: Mon=bit0(1), Tue=bit1(2), Wed=bit2(4), Thu=bit3(8), Fri=bit4(16).
 */

const MWF = 1 | 4 | 16; // Mon, Wed, Fri

let nextId = 1;
function daysOfWeek(effectiveFromDay: string, daysMask: number): HabitSchedule {
  return { id: nextId++, itemId: 1, effectiveFromDay, kind: 'days_of_week', daysMask, perWeekN: null };
}
function perWeek(effectiveFromDay: string, perWeekN: number): HabitSchedule {
  return { id: nextId++, itemId: 1, effectiveFromDay, kind: 'per_week', daysMask: null, perWeekN };
}

describe('completionRate — days-of-week', () => {
  it('rates done due days over the window, daily habit', () => {
    // Daily (no schedule). floor = earliest completion 11-06; today 11-10 done → counted.
    const r = completionRate([], ['2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10'], '2026-11-10');
    expect(r).toEqual({ done: 4, total: 5, rate: 4 / 5 }); // 11-08 missed
  });

  it('excludes the current day while it is still in progress', () => {
    const r = completionRate([], ['2026-11-06', '2026-11-07', '2026-11-09'], '2026-11-10');
    expect(r).toEqual({ done: 3, total: 4, rate: 3 / 4 }); // today (10) not done → not counted either way
  });

  it('only counts days the schedule makes due', () => {
    // MWF. Due days in [13,20]: Fri13, Mon16, Wed18, Fri20(today, not done → skipped).
    const r = completionRate(
      [daysOfWeek('2026-01-01', MWF)],
      ['2026-11-13', '2026-11-16', '2026-11-20'],
      '2026-11-20',
    );
    expect(r).toEqual({ done: 3, total: 4, rate: 3 / 4 }); // Wed 11-18 missed
  });

  it('is null with no closed due period', () => {
    expect(completionRate([], [], '2026-11-20')).toEqual({ done: 0, total: 0, rate: null });
  });

  it('honours the window size', () => {
    const days = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
    const r = completionRate([], days, '2026-11-10', 3); // last 3 due days 08,09,10 all done
    expect(r).toEqual({ done: 3, total: 3, rate: 1 });
  });
});

describe('completionRate — per week', () => {
  it('rates weeks meeting N, counting a met current week', () => {
    const r = completionRate(
      [perWeek('2026-01-01', 2)],
      // wk 11-02: 2 ✓, wk 11-09: 1 ✗, current wk 11-16: 2 ✓
      ['2026-11-03', '2026-11-05', '2026-11-11', '2026-11-16', '2026-11-18'],
      '2026-11-20',
    );
    expect(r).toEqual({ done: 2, total: 3, rate: 2 / 3 });
  });

  it('skips an unmet current week as in progress', () => {
    const r = completionRate(
      [perWeek('2026-01-01', 2)],
      ['2026-11-03', '2026-11-05', '2026-11-11'], // nothing in current week 11-16
      '2026-11-20',
    );
    expect(r).toEqual({ done: 1, total: 2, rate: 1 / 2 });
  });
});

describe('setCompletionRate', () => {
  function leaf(completionDays: string[]): HabitHistoryNode {
    return { kind: 'habit', children: [], schedules: [], completionDays: new Set(completionDays) };
  }

  it('rates derived set done over derived due days', () => {
    const node: HabitHistoryNode = {
      kind: 'habit',
      children: [leaf(['2026-11-08', '2026-11-09', '2026-11-10']), leaf(['2026-11-08', '2026-11-10'])],
      schedules: [],
      completionDays: new Set(),
    };
    // Both leaves daily ⇒ set due every day. done: 08 ✓, 09 ✗ (B missing), 10 ✓ (today, done).
    expect(setCompletionRate(node, '2026-11-10')).toEqual({ done: 2, total: 3, rate: 2 / 3 });
  });
});

describe('habitWeeksEndingAt', () => {
  it('returns count week-starts oldest first, ending at the last', () => {
    expect(habitWeeksEndingAt('2026-11-16', 3)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
  });

  it('returns [] for a non-positive count', () => {
    expect(habitWeeksEndingAt('2026-11-16', 0)).toEqual([]);
  });
});

describe('habitMonthSpans', () => {
  it('spans a month across the rows holding its days, including a mid-week boundary', () => {
    // Week 0 (Mon 2026-10-26) holds Oct 26–31 AND Nov 1; weeks 1–2 are all November.
    const spans = habitMonthSpans(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(spans).toEqual([
      { year: 2026, month: 10, monthName: 'Oct', startRow: 0, endRow: 0 },
      { year: 2026, month: 11, monthName: 'Nov', startRow: 0, endRow: 2 },
    ]);
  });

  it('is empty for no weeks', () => {
    expect(habitMonthSpans([])).toEqual([]);
  });
});
