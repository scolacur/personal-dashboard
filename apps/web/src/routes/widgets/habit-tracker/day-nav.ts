import { addHabitDays, HABIT_MONTH_NAMES, HABIT_WEEKDAY_NAMES, habitWeekday } from '@dashboard/shared';

/**
 * Day navigation on the Today surface (PD-779 ([Habit Tracker] date header + day arrows on Today)).
 *
 * The Today page and card can step one **habit day** back or forward. These helpers hold the rules,
 * pure and DOM-free so they are unit-testable:
 *   - there is no lower bound: the left arrow always steps back;
 *   - there is an upper bound: navigation never goes past the current habit day (`today`);
 *   - the header shows a relative label ("Today", "Yesterday") where one applies, beside the date.
 *
 * Days are `YYYY-MM-DD` habit days, so comparing them as strings orders them by date.
 */

/** The habit day `delta` days from `day`, never later than `today`. */
export function stepHabitDay(day: string, delta: number, today: string): string {
  const next = addHabitDays(day, delta);
  return next > today ? today : next;
}

/** Whether the right arrow can step forward from `day` (false on today, and on any later day). */
export function canStepForward(day: string, today: string): boolean {
  return day < today;
}

/** "Today" / "Yesterday" for those two days; otherwise null (the date alone is shown). */
export function relativeDayLabel(day: string, today: string): 'Today' | 'Yesterday' | null {
  if (day === today) return 'Today';
  if (day === addHabitDays(today, -1)) return 'Yesterday';
  return null;
}

/**
 * The date shown in the header: "Tue, Nov 24", with the year appended ("Mon, Dec 29, 2025") when it
 * differs from today's. Built from the habit-day string itself, so no timezone can shift it.
 */
export function formatHabitDate(day: string, today: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const base = `${HABIT_WEEKDAY_NAMES[habitWeekday(day)]}, ${HABIT_MONTH_NAMES[month - 1]} ${date}`;
  return day.slice(0, 4) === today.slice(0, 4) ? base : `${base}, ${year}`;
}
