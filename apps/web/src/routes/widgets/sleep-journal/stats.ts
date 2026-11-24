import { addSleepDays, type SleepEntry } from '@dashboard/shared';
import { minutesOf } from './time';

/**
 * Pure aggregation for the Trends tab. No DOM and no fetch, so every number the view shows is
 * unit-tested here. Nights are keyed by wake date; times of day are home-zone wall clock.
 */

/** Below this many nights a group is dimmed and marked "too few to tell". */
export const MIN_N = 5;

export type RangeId = '7d' | '30d' | '90d' | 'all';

export const RANGES: { value: RangeId; label: string; days: number | null }[] = [
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
  { value: '90d', label: '90d', days: 90 },
  { value: 'all', label: 'All', days: null },
];

/** The first wake date in range, counting today as day 1. Null for "All". */
export function rangeSince(range: RangeId, today: string): string | null {
  const days = RANGES.find((r) => r.value === range)?.days ?? null;
  return days === null ? null : addSleepDays(today, -(days - 1));
}

export interface Group {
  n: number;
  /** Null when n = 0. */
  avg: number | null;
}

export function group(values: number[]): Group {
  return { n: values.length, avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}

export function durationMs(e: Pick<SleepEntry, 'sleepAt' | 'wakeAt'>): number {
  return e.wakeAt - e.sleepAt;
}

/**
 * Bedtimes straddle midnight, so a plain mean of 23:30 and 00:30 would be noon. Times before noon
 * count as "after midnight" (+24h) before averaging, then wrap back.
 */
export function averageBedtime(minutes: number[]): number | null {
  if (minutes.length === 0) return null;
  const shifted = minutes.map((m) => (m < 12 * 60 ? m + 1440 : m));
  return Math.round(shifted.reduce((a, b) => a + b, 0) / shifted.length) % 1440;
}

/** Wake times are a plain mean: nobody wakes across midnight. */
export function averageWakeTime(minutes: number[]): number | null {
  if (minutes.length === 0) return null;
  return Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length);
}

export interface Summary {
  n: number;
  avgDurationMs: number | null;
  avgRested: number | null;
  /** Minutes past midnight. */
  avgSleepMinutes: number | null;
  avgWakeMinutes: number | null;
}

export function summarize(entries: SleepEntry[]): Summary {
  return {
    n: entries.length,
    avgDurationMs: group(entries.map(durationMs)).avg,
    avgRested: group(entries.map((e) => e.rested)).avg,
    avgSleepMinutes: averageBedtime(entries.map((e) => minutesOf(e.sleepAt))),
    avgWakeMinutes: averageWakeTime(entries.map((e) => minutesOf(e.wakeAt))),
  };
}

export interface TagComparison {
  tag: string;
  /** Average rested on nights with the tag. */
  with: Group;
  /** Average rested on nights without it. */
  without: Group;
  /** Average count on the nights with it. */
  avgCount: number;
}

/** For every tag used in range: rested with it vs. without it. Most-used first. */
export function byTag(entries: SleepEntry[]): TagComparison[] {
  const tags = [...new Set(entries.flatMap((e) => e.tags.map((t) => t.name)))];
  return tags
    .map((tag) => {
      const withTag = entries.filter((e) => e.tags.some((t) => t.name === tag));
      const counts = withTag.map((e) => e.tags.find((t) => t.name === tag)?.count ?? 0);
      return {
        tag,
        with: group(withTag.map((e) => e.rested)),
        without: group(entries.filter((e) => !e.tags.some((t) => t.name === tag)).map((e) => e.rested)),
        avgCount: counts.reduce((a, b) => a + b, 0) / counts.length,
      };
    })
    .sort((a, b) => b.with.n - a.with.n || a.tag.localeCompare(b.tag));
}

/** One decimal, dropping ".0": 4 → "4", 4.25 → "4.3". */
export function fmtAvg(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
