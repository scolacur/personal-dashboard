import { addHabitDays, habitWeekStart } from '@dashboard/shared';
import type { DayEntry } from './days';

/**
 * Geometry for the Log calendar: Monday–Sunday rows, newest week at the bottom. An adapted copy of
 * the Habit Tracker's By Habit helpers (no cross-widget imports); the week and month helpers come
 * from `@dashboard/shared`.
 */

export interface DayCell {
  day: string;
  /** Week row, 0 = oldest shown. */
  row: number;
  /** 0 = Mon. */
  col: number;
  dayNum: number;
  entry: DayEntry | null;
  future: boolean;
}

export function buildCells(weekStarts: string[], byDay: Map<string, DayEntry>, today: string): DayCell[] {
  const out: DayCell[] = [];
  weekStarts.forEach((weekStart, row) => {
    for (let col = 0; col < 7; col += 1) {
      const day = addHabitDays(weekStart, col);
      out.push({ day, row, col, dayNum: Number(day.slice(8, 10)), entry: byDay.get(day) ?? null, future: day > today });
    }
  });
  return out;
}

/** Weeks from the week holding `fromDay` to the one holding `toDay`, inclusive (at least 1). */
export function weekSpanCount(fromDay: string, toDay: string): number {
  const toMs = Date.parse(`${habitWeekStart(toDay)}T00:00:00Z`);
  const fromMs = Date.parse(`${habitWeekStart(fromDay)}T00:00:00Z`);
  if (toMs < fromMs) return 1;
  return Math.round((toMs - fromMs) / (7 * 86_400_000)) + 1;
}
