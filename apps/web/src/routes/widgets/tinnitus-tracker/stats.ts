import type { TinnitusEntry } from '@dashboard/shared';

/**
 * Pure aggregation for the Trends tab (PD-706). No DOM and no fetch, so every number the charts draw
 * is unit-tested here.
 *
 * Everything is local time, because "morning" and "a day" are wall-clock ideas.
 */

/** Below this many readings a group is dimmed and marked "too few to tell". */
export const MIN_N = 5;

export type RangeId = '7d' | '30d' | '90d' | 'all';

export const RANGES: { value: RangeId; label: string; days: number | null }[] = [
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
  { value: '90d', label: '90d', days: 90 },
  { value: 'all', label: 'All', days: null },
];

/**
 * Start of the range (unix ms). "7d" means today plus the six days before it, starting at local
 * midnight, so the first day isn't cut off partway through.
 */
export function rangeStart(range: RangeId, now = Date.now()): number {
  const days = RANGES.find((r) => r.value === range)?.days ?? null;
  if (days === null) return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

export interface Group {
  n: number;
  /** Null when n = 0. */
  avg: number | null;
}

function group(values: number[]): Group {
  return { n: values.length, avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface DayPoint extends Group {
  /** Local midnight. */
  day: number;
}

/** One point per day that has readings, oldest first. Days without readings are skipped, not zero. */
export function dailyAverages(entries: TinnitusEntry[]): DayPoint[] {
  const byDay: Record<number, number[]> = {};
  for (const e of entries) (byDay[startOfDay(e.recordedAt)] ??= []).push(e.intensity);
  return Object.entries(byDay)
    .map(([day, values]) => ({ day: Number(day), ...group(values) }))
    .sort((a, b) => a.day - b.day);
}

export interface TagComparison {
  tag: string;
  with: Group;
  without: Group;
}

/**
 * For every tag used in range: readings carrying it vs. readings that don't. A tag counts only if
 * it is on that entry (PD-706 spec). Most-used tags come first.
 */
export function byTag(entries: TinnitusEntry[]): TagComparison[] {
  const tags = [...new Set(entries.flatMap((e) => e.tags))];
  return tags
    .map((tag) => ({
      tag,
      with: group(entries.filter((e) => e.tags.includes(tag)).map((e) => e.intensity)),
      without: group(entries.filter((e) => !e.tags.includes(tag)).map((e) => e.intensity)),
    }))
    .sort((a, b) => b.with.n - a.with.n || a.tag.localeCompare(b.tag));
}

export const DAYPARTS = [
  { id: 'morning', label: 'Morning', hours: '5–12', from: 5, to: 12 },
  { id: 'afternoon', label: 'Afternoon', hours: '12–17', from: 12, to: 17 },
  { id: 'evening', label: 'Evening', hours: '17–22', from: 17, to: 22 },
  { id: 'night', label: 'Night', hours: '22–5', from: 22, to: 5 },
] as const;

export type DaypartId = (typeof DAYPARTS)[number]['id'];

export function daypartOf(ms: number): DaypartId {
  const h = new Date(ms).getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

export interface DaypartGroup extends Group {
  id: DaypartId;
  label: string;
  hours: string;
}

/** Always four groups in clock order, including empty ones, so the chart's rows never move. */
export function byDaypart(entries: TinnitusEntry[]): DaypartGroup[] {
  return DAYPARTS.map((p) => ({
    id: p.id,
    label: p.label,
    hours: p.hours,
    ...group(entries.filter((e) => daypartOf(e.recordedAt) === p.id).map((e) => e.intensity)),
  }));
}

/** One decimal, dropping ".0": 4 → "4", 4.25 → "4.3". */
export function fmtAvg(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
