/**
 * Habit Tracker shared types + the habit-day function (PD-721, D-092).
 *
 * The store lives in `apps/server/src/lib/habits.ts` (D-092: a shared domain store, not a widget's
 * tables). These are the shapes crossing the wire, plus `habitDay`, which the server and the client
 * must compute *identically* — "today" on the card, the page and the server has to be the same local
 * date, or a tick taken at 00:30 is recorded against a day the UI never shows.
 *
 * The glossary (root PROJECT.md §9, "Habit Tracker") is the source of the terms used here. This
 * tracer slice (PD-721) only exercises `kind: 'habit'`; `metricType`, sets (`parentId`) and the
 * schedule/metric tables arrive in later slices, which extend this shape without migrating it.
 */

export type HabitItemKind = 'habit' | 'metric';
export type HabitMetricType = 'time' | 'number' | 'choice';

/** A habit, set or metric. One row of `habit_items`. */
export interface HabitItem {
  id: number;
  /** The containing set, or null for a top-level item. Only `null` is used in this slice. */
  parentId: number | null;
  kind: HabitItemKind;
  /** Null unless `kind === 'metric'`. */
  metricType: HabitMetricType | null;
  name: string;
  /** Manual order among siblings, ascending. */
  sortOrder: number;
  /** Unix ms when archived, or null while active. */
  archivedAt: number | null;
  createdAt: number;
}

/**
 * A `HabitItem` carrying its completion tally — what the list endpoint returns.
 *
 * `completionCount` is derived, not stored, so it is kept off the plain row type: the Habits tab
 * needs it to name the count in the delete confirmation ("Delete Gym and its 84 completions?")
 * without a second round-trip.
 */
export interface HabitItemView extends HabitItem {
  completionCount: number;
}

/** One completion of one item on one habit day. PK is `(itemId, day)`. */
export interface HabitCompletion {
  itemId: number;
  /** A habit day: a local calendar date `YYYY-MM-DD`, not an instant. */
  day: string;
  /** Unix ms of the moment the tick was recorded. */
  completedAt: number;
}

export interface HabitSettings {
  /** Minutes past local midnight at which a new habit day begins (default 04:00 → 240). */
  dayBoundaryMinutes: number;
  /** IANA timezone the habit day is computed in. */
  timezone: string;
}

export const DEFAULT_DAY_BOUNDARY_MINUTES = 240;
export const DEFAULT_HABIT_TIMEZONE = 'America/New_York';
export const MINUTES_PER_DAY = 1440;
export const HABIT_NAME_MAX_LENGTH = 200;

/** `YYYY-MM-DD`. */
export const HABIT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isHabitDay(value: unknown): value is string {
  return typeof value === 'string' && HABIT_DAY_PATTERN.test(value);
}

export function isValidDayBoundaryMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY;
}

/** True if `tz` is a timezone the host's `Intl` recognises. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Local wall-clock date + minutes-past-midnight at `instantMs` in `timeZone`. */
function localWallClock(
  instantMs: number,
  timeZone: string,
): { year: number; month: number; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  // `h23` yields 00–23, but some engines still emit '24' for midnight — fold it back.
  const hour = get('hour') % 24;
  return { year: get('year'), month: get('month'), day: get('day'), minutes: hour * 60 + get('minute') };
}

/**
 * The habit day an instant falls in: a local calendar date `YYYY-MM-DD`.
 *
 * The day boundary (default 04:00) is applied in wall-clock terms: a tick before the boundary
 * belongs to the previous calendar date, one at or after it to the current date. Working on the
 * local wall clock rather than shifting the instant is what makes this correct across DST — the
 * one-day step is pure calendar arithmetic (done in UTC so no offset leaks in), never a subtraction
 * of 24h of real time.
 */
export function habitDay(instantMs: number, settings: HabitSettings): string {
  const { year, month, day, minutes } = localWallClock(instantMs, settings.timezone);
  if (minutes >= settings.dayBoundaryMinutes) return isoDate(year, month, day);

  // Before the boundary → the previous calendar date. Step a day in UTC, which has no DST.
  const prev = new Date(Date.UTC(year, month - 1, day) - 86_400_000);
  return isoDate(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
}
