import { addHabitDays, habitWeekday, HABIT_WEEKDAY_NAMES, type MoodEnergyEntry } from '@dashboard/shared';

/**
 * Pure aggregation for the Trends tab. No DOM and no fetch, so every number the charts draw is
 * unit-tested here. Entries are days (one per habit day), so everything keys on `day`, never on a
 * timestamp.
 */

/** Below this many days a group is dimmed and marked "too few to tell". */
export const MIN_N = 5;

export type RangeId = '7d' | '30d' | '90d' | 'all';

export const RANGES: { value: RangeId; label: string; days: number | null }[] = [
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
  { value: '90d', label: '90d', days: 90 },
  { value: 'all', label: 'All', days: null },
];

/** The first day in range ("7d" is today and the six days before it), or null for All. */
export function rangeSince(range: RangeId, today: string): string | null {
  const days = RANGES.find((r) => r.value === range)?.days ?? null;
  return days === null ? null : addHabitDays(today, -(days - 1));
}

export function inRange<T extends MoodEnergyEntry>(entries: T[], since: string | null, today: string): T[] {
  return entries.filter((e) => (since === null || e.day >= since) && e.day <= today);
}

export interface Group {
  n: number;
  /** Null when n = 0. */
  avg: number | null;
}

function group(values: number[]): Group {
  return { n: values.length, avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}

export interface Summary {
  n: number;
  mood: number | null;
  energy: number | null;
}

export function summary(entries: MoodEnergyEntry[]): Summary {
  return { n: entries.length, mood: group(entries.map((e) => e.mood)).avg, energy: group(entries.map((e) => e.energy)).avg };
}

export interface DayPoint {
  day: string;
  mood: number;
  energy: number;
}

/** One point per logged day, oldest first. Unlogged days are skipped, not zero. */
export function dailySeries(entries: MoodEnergyEntry[]): DayPoint[] {
  return entries
    .map((e) => ({ day: e.day, mood: e.mood, energy: e.energy }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface TagComparison {
  tag: string;
  with: Group;
  without: Group;
}

/** For every tag in range: average mood on days with it vs. days without. Most-used first. */
export function byTag(entries: MoodEnergyEntry[]): TagComparison[] {
  const tags = [...new Set(entries.flatMap((e) => e.tags))];
  return tags
    .map((tag) => ({
      tag,
      with: group(entries.filter((e) => e.tags.includes(tag)).map((e) => e.mood)),
      without: group(entries.filter((e) => !e.tags.includes(tag)).map((e) => e.mood)),
    }))
    .sort((a, b) => b.with.n - a.with.n || a.tag.localeCompare(b.tag));
}

export interface WeekdayGroup extends Group {
  /** 0 = Mon. */
  weekday: number;
  label: string;
}

/** Average mood per weekday: always seven groups, Monday first, so the rows never move. */
export function byWeekday(entries: MoodEnergyEntry[]): WeekdayGroup[] {
  return HABIT_WEEKDAY_NAMES.map((label, weekday) => ({
    weekday,
    label,
    ...group(entries.filter((e) => habitWeekday(e.day) === weekday).map((e) => e.mood)),
  }));
}

/** One decimal, dropping ".0": 4 → "4", 3.25 → "3.3". */
export function fmtAvg(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
