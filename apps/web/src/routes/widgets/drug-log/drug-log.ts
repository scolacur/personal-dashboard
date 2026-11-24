import {
  addHabitDays,
  habitDay,
  habitWeekday,
  habitWeekStart,
  HABIT_MONTH_NAMES,
  HABIT_WEEKDAY_NAMES,
  type DrugLogDrug,
  type HabitSettings,
} from '@dashboard/shared';

/**
 * Pure derivations for the Drug Log (PD-975, Drug log widget): today's badge counts, the Log's By
 * Day groups, the By Drug calendar cells and header stats, and the button label sizing. No DOM and
 * no fetches, so all of it is unit-tested (`drug-log.spec.ts`).
 *
 * A "day" is always a **habit day** under the Habit Tracker's settings (see
 * `DRUG_LOG_FALLBACK_DAY_SETTINGS`), so callers pass `settings` through rather than this module
 * assuming a boundary.
 */

/** The minimal shape of an event these functions read — a synced event or a pending tap. */
export interface Tap {
  drugId: number;
  recordedAt: number;
}

const DAY_MS = 86_400_000;

/* ── Drugs ──────────────────────────────────── */

/** Grid order: by `sortOrder`, then id. */
export function sortDrugs<T extends Pick<DrugLogDrug, 'sortOrder' | 'id'>>(drugs: T[]): T[] {
  return [...drugs].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export function activeDrugs(drugs: DrugLogDrug[]): DrugLogDrug[] {
  return sortDrugs(drugs.filter((d) => d.archivedAt === null));
}

export function archivedDrugs(drugs: DrugLogDrug[]): DrugLogDrug[] {
  return sortDrugs(drugs.filter((d) => d.archivedAt !== null));
}

/**
 * The `sortOrder` patches that move `id` one place earlier (`-1`) or later (`+1`) among the active
 * drugs. Re-numbers the whole active list 0..n-1 so ties from older data can't make a move a no-op.
 * Returns only the drugs whose order actually changes; empty when the move is off either end.
 */
export function moveDrug(
  drugs: DrugLogDrug[],
  id: number,
  delta: -1 | 1,
): { id: number; sortOrder: number }[] {
  const list = activeDrugs(drugs);
  const i = list.findIndex((d) => d.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  return list
    .map((d, sortOrder) => ({ id: d.id, sortOrder }))
    .filter((p, k) => list[k].sortOrder !== p.sortOrder);
}

/* ── Counting ───────────────────────────────── */

/**
 * How far back to fetch so every event of today's habit day is included: a habit day is at most
 * 25 h long (a DST fall-back), so 26 h before now always reaches its start.
 */
export const TODAY_LOOKBACK_MS = 26 * 3_600_000;

/** Taps per drug on habit day `day`. */
export function countsForDay(
  taps: Tap[],
  day: string,
  settings: HabitSettings,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of taps) {
    if (habitDay(t.recordedAt, settings) !== day) continue;
    out.set(t.drugId, (out.get(t.drugId) ?? 0) + 1);
  }
  return out;
}

/** Taps per habit day for one drug. */
export function countsByDay(
  taps: Tap[],
  drugId: number,
  settings: HabitSettings,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of taps) {
    if (t.drugId !== drugId) continue;
    const day = habitDay(t.recordedAt, settings);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

/* ── Log › By Day ───────────────────────────── */

export interface DayGroup<E extends Tap> {
  day: string;
  total: number;
  /** One per drug with at least one tap that day, in `drugOrder`; unknown drugs last. */
  counts: { drugId: number; count: number }[];
  /** That day's events, newest first. */
  events: E[];
}

/**
 * One group per habit day from `toDay` back to `fromDay` (inclusive), newest first — empty days
 * included, so a quiet day reads as quiet rather than vanishing. Events outside the range are
 * ignored (the fetch window is deliberately wider than the range; see {@link fetchSinceForDay}).
 */
export function groupByDay<E extends Tap>(
  events: E[],
  drugOrder: number[],
  fromDay: string,
  toDay: string,
  settings: HabitSettings,
): DayGroup<E>[] {
  const byDay = new Map<string, E[]>();
  for (const e of events) {
    const day = habitDay(e.recordedAt, settings);
    if (day < fromDay || day > toDay) continue;
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }
  const rank = new Map(drugOrder.map((id, i) => [id, i]));
  const out: DayGroup<E>[] = [];
  for (let day = toDay; day >= fromDay; day = addHabitDays(day, -1)) {
    const list = (byDay.get(day) ?? []).sort((a, b) => b.recordedAt - a.recordedAt);
    const tally = new Map<number, number>();
    for (const e of list) tally.set(e.drugId, (tally.get(e.drugId) ?? 0) + 1);
    const counts = [...tally]
      .map(([drugId, count]) => ({ drugId, count }))
      .sort(
        (a, b) =>
          (rank.get(a.drugId) ?? Infinity) - (rank.get(b.drugId) ?? Infinity) ||
          a.drugId - b.drugId,
      );
    out.push({ day, total: list.length, counts, events: list });
  }
  return out;
}

/**
 * A `since` (unix ms) safely before the start of habit day `day` in any timezone and with any
 * boundary: midnight UTC of that date, less two days. The caller filters by habit day afterwards.
 */
export function fetchSinceForDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - 2 * DAY_MS;
}

/** "Today", "Yesterday", else e.g. "Mon 23 Nov" (with the year when it isn't this year's). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === addHabitDays(today, -1)) return 'Yesterday';
  // Built by hand rather than with `toLocaleDateString`, whose punctuation varies by runtime.
  const [y, m, d] = day.split('-').map(Number);
  const base = `${HABIT_WEEKDAY_NAMES[habitWeekday(day)]} ${d} ${HABIT_MONTH_NAMES[m - 1]}`;
  return day.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${y}`;
}

/* ── Log › By Drug ──────────────────────────── */

export interface CalendarCell {
  day: string;
  /** Week row (0 = oldest shown). */
  row: number;
  /** 0 = Monday. */
  col: number;
  dayNum: number;
  count: number;
  future: boolean;
}

/** The cells for a run of Mon week-starts (oldest first). */
export function calendarCells(
  weekStarts: string[],
  counts: Map<string, number>,
  today: string,
): CalendarCell[] {
  const out: CalendarCell[] = [];
  weekStarts.forEach((weekStart, row) => {
    for (let col = 0; col < 7; col += 1) {
      const day = addHabitDays(weekStart, col);
      out.push({
        day,
        row,
        col,
        dayNum: Number(day.slice(8, 10)),
        count: day > today ? 0 : (counts.get(day) ?? 0),
        future: day > today,
      });
    }
  });
  return out;
}

/**
 * Shade strength for a cell, 0–1: 0 for no taps, otherwise from 0.3 (one tap, when the busiest day
 * has many) up to 1 (the busiest day shown). Rounded to two places so the style string is stable.
 */
export function cellIntensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const t = Math.min(count, max) / max;
  return Math.round((0.3 + 0.7 * t) * 100) / 100;
}

export interface DrugStats {
  /** Taps on the days in [fromDay, today]. */
  totalInRange: number;
  /** Days with ≥ 1 tap among the last 30 habit days (today included). */
  daysUsedLast30: number;
  /** totalInRange ÷ days with ≥ 1 tap in range; null when there were none. */
  avgPerActiveDay: number | null;
  /** Longest run of consecutive days with ≥ 1 tap, over all history. */
  longestStreak: number;
  /**
   * The run ending today — or ending yesterday when today has no tap yet, so the streak doesn't
   * read 0 all morning.
   */
  currentStreak: number;
}

export function drugStats(counts: Map<string, number>, fromDay: string, today: string): DrugStats {
  let totalInRange = 0;
  let activeInRange = 0;
  let daysUsedLast30 = 0;
  const last30 = addHabitDays(today, -29);
  const used: string[] = [];
  for (const [day, n] of counts) {
    if (n <= 0 || day > today) continue;
    used.push(day);
    if (day >= fromDay) {
      totalInRange += n;
      activeInRange += 1;
    }
    if (day >= last30) daysUsedLast30 += 1;
  }
  used.sort();

  let longestStreak = 0;
  let run = 0;
  for (let i = 0; i < used.length; i += 1) {
    run = i > 0 && addHabitDays(used[i - 1], 1) === used[i] ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }

  const has = (day: string) => (counts.get(day) ?? 0) > 0;
  let currentStreak = 0;
  let day = has(today) ? today : addHabitDays(today, -1);
  while (has(day)) {
    currentStreak += 1;
    day = addHabitDays(day, -1);
  }

  return {
    totalInRange,
    daysUsedLast30,
    avgPerActiveDay:
      activeInRange === 0 ? null : Math.round((totalInRange / activeInRange) * 10) / 10,
    longestStreak,
    currentStreak,
  };
}

/** "just now", "5m ago", "2h ago", "3d ago", "6w ago", then "1y ago". */
export function formatAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/* ── Button label ───────────────────────────── */

/**
 * Font scale (relative to the button's base size) so a label fits its circle: short labels are big,
 * 12-character ones shrink. Counted in code points so an emoji counts once.
 */
export function labelScale(label: string): number {
  const n = [...label].length;
  if (n <= 4) return 1;
  if (n <= 6) return 0.85;
  if (n <= 8) return 0.72;
  if (n <= 10) return 0.62;
  return 0.54;
}

/* ── Local list upkeep ──────────────────────── */

/** Insert or replace events by id, keeping the list newest first. */
export function mergeEvents<E extends { id: number; recordedAt: number }>(
  list: E[],
  incoming: E[],
): E[] {
  const ids = new Set(incoming.map((e) => e.id));
  return [...list.filter((e) => !ids.has(e.id)), ...incoming].sort(
    (a, b) => b.recordedAt - a.recordedAt || b.id - a.id,
  );
}

/** Habit weeks from the week holding `fromDay` to the week holding `toDay`, inclusive (≥ 1). */
export function weekSpanCount(fromDay: string, toDay: string): number {
  const toMs = Date.parse(`${habitWeekStart(toDay)}T00:00:00Z`);
  const fromMs = Date.parse(`${habitWeekStart(fromDay)}T00:00:00Z`);
  if (toMs < fromMs) return 1;
  return Math.round((toMs - fromMs) / (7 * DAY_MS)) + 1;
}
