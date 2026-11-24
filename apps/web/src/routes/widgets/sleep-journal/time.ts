import { sleepWallClock, SLEEP_TIMEZONE } from '@dashboard/shared';

/**
 * Time helpers for the Sleep Journal. Everything is wall clock in the home zone
 * (`SLEEP_TIMEZONE`), because "which night" and "went to sleep at 23:10" are wall-clock questions.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes past midnight → the `HH:MM` an `<input type="time">` takes. */
export function toTimeInput(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** The reverse. Null for an empty or unparseable value. */
export function fromTimeInput(value: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Minutes past midnight of an instant, in the home zone. */
export function minutesOf(ms: number): number {
  return sleepWallClock(ms).minutes;
}

/** "23:10" for an instant, in the home zone. */
export function formatClock(ms: number): string {
  return toTimeInput(minutesOf(ms));
}

/** Rounded down to five minutes, for the wake-time default. */
export function roundDownToFive(minutes: number): number {
  return Math.floor(minutes / 5) * 5;
}

/** "7h 25m", "45m", "8h". Negative or junk durations read as "–". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "Tue 24 Nov" for a `YYYY-MM-DD`. Formatted in UTC, since the date is already a local date. */
export function formatWakeDate(date: string, opts: { year?: boolean } = {}): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(opts.year ? { year: 'numeric' } : {}),
  });
}

/** Today's wake date in the home zone. */
export function todayWakeDate(now = Date.now()): string {
  return sleepWallClock(now, SLEEP_TIMEZONE).date;
}
