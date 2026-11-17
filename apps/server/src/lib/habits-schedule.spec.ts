import { describe, it, expect } from 'vitest';
import {
  addHabitDays,
  habitWeekday,
  habitWeekStart,
  isDue,
  perWeekProgress,
  scheduleForDay,
  scheduleLabel,
  streak,
  type HabitSchedule,
} from '@dashboard/shared';

/**
 * Pure schedule / due / streak logic (PD-722, D-095). These functions live in `@dashboard/shared`
 * and are tested here, the way `habitDay` is (`habits.spec.ts`), since the shared package has no
 * runner of its own.
 *
 * The anchor week is Mon 2026-11-16 … Sun 2026-11-22 (verified by `habitWeekday` below).
 * Weekday bits are Monday-indexed: Mon=bit0(1), Tue=bit1(2), Wed=bit2(4), Thu=bit3(8), Fri=bit4(16).
 */

const MWF = 1 | 4 | 16; // 21 — Mon, Wed, Fri
const TUE_THU = 2 | 8; // 10 — Tue, Thu

let nextId = 1;
function daysOfWeek(effectiveFromDay: string, daysMask: number, itemId = 1): HabitSchedule {
  return { id: nextId++, itemId, effectiveFromDay, kind: 'days_of_week', daysMask, perWeekN: null };
}
function perWeek(effectiveFromDay: string, perWeekN: number, itemId = 1): HabitSchedule {
  return { id: nextId++, itemId, effectiveFromDay, kind: 'per_week', daysMask: null, perWeekN };
}

describe('calendar helpers', () => {
  it('is Monday-indexed and anchors the test week', () => {
    expect(habitWeekday('2026-11-16')).toBe(0); // Mon
    expect(habitWeekday('2026-11-17')).toBe(1); // Tue
    expect(habitWeekday('2026-11-22')).toBe(6); // Sun
    expect(habitWeekStart('2026-11-18')).toBe('2026-11-16');
    expect(habitWeekStart('2026-11-16')).toBe('2026-11-16');
    expect(addHabitDays('2026-11-16', 7)).toBe('2026-11-23');
    expect(addHabitDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('scheduleForDay', () => {
  it('picks the latest row whose effective day has arrived', () => {
    const a = daysOfWeek('2026-11-02', MWF);
    const b = daysOfWeek('2026-11-23', TUE_THU);
    expect(scheduleForDay([a, b], '2026-11-20')).toBe(a);
    expect(scheduleForDay([a, b], '2026-11-24')).toBe(b);
    expect(scheduleForDay([a, b], '2026-10-01')).toBeNull(); // before any row
    expect(scheduleForDay([], '2026-11-20')).toBeNull(); // no rows → daily
  });
});

describe('isDue', () => {
  it('days-of-week: due only on masked weekdays', () => {
    const s = [daysOfWeek('2026-01-01', MWF)];
    expect(isDue(s, '2026-11-16')).toBe(true); // Mon
    expect(isDue(s, '2026-11-17')).toBe(false); // Tue
    expect(isDue(s, '2026-11-18')).toBe(true); // Wed
    expect(isDue(s, '2026-11-19')).toBe(false); // Thu
    expect(isDue(s, '2026-11-20')).toBe(true); // Fri
  });

  it('no schedule is daily', () => {
    expect(isDue([], '2026-11-17')).toBe(true);
  });

  it('per-week is on Today every day', () => {
    const s = [perWeek('2026-01-01', 3)];
    expect(isDue(s, '2026-11-16')).toBe(true);
    expect(isDue(s, '2026-11-22')).toBe(true);
  });
});

describe('perWeekProgress', () => {
  const s = [perWeek('2026-01-01', 3)];

  it('counts completions in the Mon–Sun week and reports met at N', () => {
    const twice = ['2026-11-16', '2026-11-18'];
    expect(perWeekProgress(s, '2026-11-22', twice)).toEqual({ count: 2, target: 3, met: false });

    const thrice = [...twice, '2026-11-20'];
    expect(perWeekProgress(s, '2026-11-22', thrice)).toEqual({ count: 3, target: 3, met: true });
  });

  it('ignores completions in other weeks', () => {
    const across = ['2026-11-15', '2026-11-16', '2026-11-18', '2026-11-20']; // 11-15 is the prior week
    expect(perWeekProgress(s, '2026-11-18', across)?.count).toBe(3);
  });

  it('is null for a days-of-week schedule', () => {
    expect(perWeekProgress([daysOfWeek('2026-01-01', MWF)], '2026-11-18', [])).toBeNull();
  });
});

describe('streak — days of week', () => {
  const mwf = [daysOfWeek('2026-11-01', MWF)];
  const mwfDone = ['2026-11-16', '2026-11-18', '2026-11-20']; // Mon, Wed, Fri

  it('counts consecutive done due days, skipping not-due days', () => {
    expect(streak(mwf, mwfDone, '2026-11-20')).toEqual({ current: 3, longest: 3 });
  });

  it('an extra (a completion on a not-due day) neither counts nor extends', () => {
    const withExtra = [...mwfDone, '2026-11-17']; // Tuesday extra
    expect(streak(mwf, withExtra, '2026-11-20')).toEqual({ current: 3, longest: 3 });
  });

  it('a missed due day breaks it', () => {
    const daily: HabitSchedule[] = []; // every day due
    const gapped = ['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20']; // 11-18 missed
    expect(streak(daily, gapped, '2026-11-20')).toEqual({ current: 2, longest: 2 });
  });

  it('an unfinished due today does not break the streak', () => {
    const daily: HabitSchedule[] = [];
    const doneThrough = ['2026-11-16', '2026-11-17', '2026-11-18'];
    // 2026-11-19 is due (daily) but not done — still in progress.
    expect(streak(daily, doneThrough, '2026-11-19')).toEqual({ current: 3, longest: 3 });
  });

  it('judges past days by the schedule in force then (effective-dated change)', () => {
    const history = [
      '2026-11-02', '2026-11-04', '2026-11-06', // week 1 MWF
      '2026-11-09', '2026-11-11', '2026-11-13', // week 2 MWF
      '2026-11-16', '2026-11-18', '2026-11-20', // week 3 MWF
    ];
    const s1 = daysOfWeek('2026-11-02', MWF);
    // Before any change: 9 consecutive MWF days done.
    expect(streak([s1], history, '2026-11-20')).toEqual({ current: 9, longest: 9 });

    // Switch to Tue/Thu from the next Monday. The future row must not rewrite the past streak.
    const s2 = daysOfWeek('2026-11-23', TUE_THU);
    expect(streak([s1, s2], history, '2026-11-20')).toEqual({ current: 9, longest: 9 });

    // After the change, a Tuesday completion extends the streak the old MWF history still anchors.
    const extended = [...history, '2026-11-24'];
    expect(streak([s1, s2], extended, '2026-11-24').current).toBe(10);
  });
});

describe('streak — per week', () => {
  const s = [perWeek('2026-10-01', 3)];
  const metTwoWeeks = [
    '2026-11-02', '2026-11-04', '2026-11-06', // week met
    '2026-11-09', '2026-11-11', '2026-11-13', // week met
  ];

  it('an in-progress current week does not break the streak', () => {
    const partial = [...metTwoWeeks, '2026-11-16', '2026-11-18']; // only 2 of 3 this week
    expect(streak(s, partial, '2026-11-18')).toEqual({ current: 2, longest: 2 });
  });

  it('reaching N in the current week counts it', () => {
    const full = [...metTwoWeeks, '2026-11-16', '2026-11-18', '2026-11-20']; // 3 this week
    expect(streak(s, full, '2026-11-20')).toEqual({ current: 3, longest: 3 });
  });

  it('a week short of N breaks it', () => {
    const broken = [
      '2026-11-02', '2026-11-04', // week 1 short (2 < 3)
      '2026-11-09', '2026-11-11', '2026-11-13', // week 2 met
      '2026-11-16', '2026-11-18', '2026-11-20', // current week met
    ];
    expect(streak(s, broken, '2026-11-20')).toEqual({ current: 2, longest: 2 });
  });
});

describe('scheduleLabel', () => {
  it('describes each kind', () => {
    expect(scheduleLabel(null)).toBe('Every day');
    expect(scheduleLabel(daysOfWeek('2026-01-01', 0b111_1111))).toBe('Every day');
    expect(scheduleLabel(daysOfWeek('2026-01-01', MWF))).toBe('Mon, Wed, Fri');
    expect(scheduleLabel(perWeek('2026-01-01', 3))).toBe('3× per week');
  });
});
