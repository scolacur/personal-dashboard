import { addHabitDays, habitWeekStart, type SleepEntry } from '@dashboard/shared';

/**
 * Geometry for the History calendar: Monday–Sunday rows, newest week at the bottom. The week and
 * month helpers come from `@dashboard/shared` (the Habit Tracker's), never from its route folder.
 */

export interface NightCell {
  /** Wake date. */
  date: string;
  /** Week row, 0 = oldest shown. */
  row: number;
  /** 0 = Mon. */
  col: number;
  dayNum: number;
  entry: SleepEntry | null;
  future: boolean;
}

export function buildCells(weekStarts: string[], byDate: Map<string, SleepEntry>, today: string): NightCell[] {
  const out: NightCell[] = [];
  weekStarts.forEach((weekStart, row) => {
    for (let col = 0; col < 7; col += 1) {
      const date = addHabitDays(weekStart, col);
      out.push({
        date,
        row,
        col,
        dayNum: Number(date.slice(8, 10)),
        entry: byDate.get(date) ?? null,
        future: date > today,
      });
    }
  });
  return out;
}

/** Weeks from the week holding `fromDate` to the one holding `toDate`, inclusive (at least 1). */
export function weekSpanCount(fromDate: string, toDate: string): number {
  const toMs = Date.parse(`${habitWeekStart(toDate)}T00:00:00Z`);
  const fromMs = Date.parse(`${habitWeekStart(fromDate)}T00:00:00Z`);
  if (toMs < fromMs) return 1;
  return Math.round((toMs - fromMs) / (7 * 86_400_000)) + 1;
}
