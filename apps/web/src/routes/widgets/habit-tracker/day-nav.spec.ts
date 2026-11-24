import { describe, it, expect } from 'vitest';
import { canStepForward, formatHabitDate, relativeDayLabel, stepHabitDay } from './day-nav';

/** Today-surface day navigation (PD-779 ([Habit Tracker] date header + day arrows on Today)). */

const TODAY = '2026-11-24'; // a Tuesday

describe('stepHabitDay', () => {
  it('steps back one habit day, across month and year boundaries, with no lower bound', () => {
    expect(stepHabitDay(TODAY, -1, TODAY)).toBe('2026-11-23');
    expect(stepHabitDay('2026-11-01', -1, TODAY)).toBe('2026-10-31');
    expect(stepHabitDay('2020-01-01', -1, TODAY)).toBe('2019-12-31');
  });

  it('steps forward one habit day', () => {
    expect(stepHabitDay('2026-11-22', 1, TODAY)).toBe('2026-11-23');
    expect(stepHabitDay('2026-11-23', 1, TODAY)).toBe(TODAY);
  });

  it('never goes past today', () => {
    expect(stepHabitDay(TODAY, 1, TODAY)).toBe(TODAY);
    expect(stepHabitDay('2026-11-23', 5, TODAY)).toBe(TODAY);
  });
});

describe('canStepForward', () => {
  it('is false on today and true on any past day', () => {
    expect(canStepForward(TODAY, TODAY)).toBe(false);
    expect(canStepForward('2026-11-23', TODAY)).toBe(true);
    expect(canStepForward('2025-01-01', TODAY)).toBe(true);
  });

  it('is false on a day after today', () => {
    expect(canStepForward('2026-11-25', TODAY)).toBe(false);
  });
});

describe('relativeDayLabel', () => {
  it('labels today and yesterday, and nothing older', () => {
    expect(relativeDayLabel(TODAY, TODAY)).toBe('Today');
    expect(relativeDayLabel('2026-11-23', TODAY)).toBe('Yesterday');
    expect(relativeDayLabel('2026-11-22', TODAY)).toBeNull();
  });

  it('labels yesterday across a month boundary', () => {
    expect(relativeDayLabel('2026-11-30', '2026-12-01')).toBe('Yesterday');
  });
});

describe('formatHabitDate', () => {
  it('shows weekday, month and day within the current year', () => {
    expect(formatHabitDate(TODAY, TODAY)).toBe('Tue, Nov 24');
    expect(formatHabitDate('2026-01-05', TODAY)).toBe('Mon, Jan 5');
  });

  it('appends the year when it differs from today', () => {
    expect(formatHabitDate('2025-12-28', TODAY)).toBe('Sun, Dec 28, 2025');
  });
});
