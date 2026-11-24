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

/* ── Schedules, due logic and streaks (PD-722, D-095) ───────────────────────────────
 *
 * A schedule says when a habit is due. It is **effective-dated**: `habit_schedules` carries one row
 * per (item, effective-from day), and the row in force on a given day is the latest one whose
 * `effectiveFromDay <= day`. A schedule change never edits a past row, so history is always judged
 * by the schedule that applied then (spec §2; the Mon/Wed/Fri → Tue/Thu test). A habit with no row
 * is treated as daily.
 *
 * All of this is pure and lives here so the server (the Today view, D-095) and any later client use
 * compute identically. The weekday mask is **Monday-indexed**: bit 0 = Monday … bit 6 = Sunday, to
 * match the Mon–Sun habit week (glossary). */

export type HabitScheduleKind = 'days_of_week' | 'per_week';

/** One row of `habit_schedules`: the schedule for `itemId` from `effectiveFromDay` onward. */
export interface HabitSchedule {
  id: number;
  itemId: number;
  /** A habit day `YYYY-MM-DD`; the schedule applies from this day forward. */
  effectiveFromDay: string;
  kind: HabitScheduleKind;
  /** 1..127, bit 0 = Mon … bit 6 = Sun. Null unless `kind === 'days_of_week'`. */
  daysMask: number | null;
  /** Completions required per habit week, ≥ 1. Null unless `kind === 'per_week'`. */
  perWeekN: number | null;
}

/** All seven weekday bits set — the default "every day" mask. */
export const DAYS_OF_WEEK_ALL = 0b111_1111; // 127
/** One completion per day caps a weekly target at seven. */
export const MAX_PER_WEEK_N = 7;
/** Monday-indexed short names; index 0 = Mon. */
export const HABIT_WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function dayUtcMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** The Monday-indexed weekday (0 = Mon … 6 = Sun) of a habit day. */
export function habitWeekday(day: string): number {
  return (new Date(dayUtcMs(day)).getUTCDay() + 6) % 7;
}

/** A habit day `delta` calendar days from `day` (pure calendar arithmetic, done in UTC). */
export function addHabitDays(day: string, delta: number): string {
  const dt = new Date(dayUtcMs(day) + delta * 86_400_000);
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** The Monday that opens the habit week containing `day`. */
export function habitWeekStart(day: string): string {
  return addHabitDays(day, -habitWeekday(day));
}

export function weekdayInMask(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0;
}

export function isValidDaysMask(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= DAYS_OF_WEEK_ALL;
}

export function isValidPerWeekN(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PER_WEEK_N;
}

/** The schedule in force on `day`: the latest row with `effectiveFromDay <= day`, or null (daily). */
export function scheduleForDay(schedules: HabitSchedule[], day: string): HabitSchedule | null {
  let best: HabitSchedule | null = null;
  for (const s of schedules) {
    if (s.effectiveFromDay <= day && (best === null || s.effectiveFromDay > best.effectiveFromDay)) {
      best = s;
    }
  }
  return best;
}

/** The mask a days-of-week schedule imposes; falls back to "every day" for daily/per-week. */
function maskOf(schedule: HabitSchedule | null): number {
  if (!schedule || schedule.kind !== 'days_of_week') return DAYS_OF_WEEK_ALL;
  return schedule.daysMask ?? DAYS_OF_WEEK_ALL;
}

/**
 * Whether the habit is "on Today" on `day`, judged by the schedule in force then:
 * a days-of-week habit is due only on its masked weekdays; a per-week habit appears every day
 * (until N is reached it is still shown, then shown as done — see {@link perWeekProgress}).
 */
export function isDue(schedules: HabitSchedule[], day: string): boolean {
  const schedule = scheduleForDay(schedules, day);
  if (!schedule || schedule.kind === 'days_of_week') {
    return weekdayInMask(maskOf(schedule), habitWeekday(day));
  }
  return true;
}

export interface PerWeekProgress {
  /** Completions in the habit week containing the day. */
  count: number;
  /** The weekly target N in force. */
  target: number;
  met: boolean;
}

/**
 * Progress through the per-week target for the habit week containing `day`, or null when the
 * schedule in force is not per-week. `completionDays` is the item's completion days (any range that
 * covers the week; days outside it are ignored).
 */
export function perWeekProgress(
  schedules: HabitSchedule[],
  day: string,
  completionDays: Iterable<string>,
): PerWeekProgress | null {
  const schedule = scheduleForDay(schedules, day);
  if (!schedule || schedule.kind !== 'per_week') return null;
  const target = schedule.perWeekN ?? 1;
  const start = habitWeekStart(day);
  const end = addHabitDays(start, 6);
  let count = 0;
  for (const c of completionDays) if (c >= start && c <= end) count++;
  return { count, target, met: count >= target };
}

export interface StreakResult {
  current: number;
  longest: number;
}

function earliestDay(days: Set<string>, fallback: string): string {
  let min = fallback;
  let seen = false;
  for (const d of days) {
    if (!seen || d < min) {
      min = d;
      seen = true;
    }
  }
  return seen ? min : fallback;
}

/**
 * The daily run logic, parameterised by `dueOn`/`doneOn` predicates so it is shared by days-of-week
 * habits (schedule-driven) and by sets (whose due/done are *derived* from their subtree, PD-723).
 *
 * Current: walk back over due days from today. A due day not done breaks it; not-due days and extras
 * are skipped; an unfinished due *today* is in progress and neither counts nor breaks. Longest: the
 * best run of consecutive done due days over `[floor, today]`.
 */
function dailyStreak(
  dueOn: (day: string) => boolean,
  doneOn: (day: string) => boolean,
  today: string,
  floor: string,
): StreakResult {
  let current = 0;
  let day = dueOn(today) && !doneOn(today) ? addHabitDays(today, -1) : today;
  while (day >= floor) {
    if (!dueOn(day)) {
      day = addHabitDays(day, -1);
      continue;
    }
    if (!doneOn(day)) break;
    current += 1;
    day = addHabitDays(day, -1);
  }

  let longest = 0;
  let run = 0;
  for (let d = floor; d <= today; d = addHabitDays(d, 1)) {
    if (!dueOn(d)) continue;
    if (doneOn(d)) {
      run += 1;
      if (run > longest) longest = run;
    } else if (d !== today) {
      run = 0; // an unfinished due today is in progress, not a break
    }
  }
  return { current, longest: Math.max(longest, current) };
}

function daysOfWeekStreak(schedules: HabitSchedule[], done: Set<string>, today: string): StreakResult {
  const dueOn = (day: string): boolean => weekdayInMask(maskOf(scheduleForDay(schedules, day)), habitWeekday(day));
  return dailyStreak(dueOn, (d) => done.has(d), today, earliestDay(done, today));
}

function perWeekStreak(schedules: HabitSchedule[], done: Set<string>, today: string): StreakResult {
  const targetFor = (weekStart: string): number => scheduleForDay(schedules, weekStart)?.perWeekN ?? 1;
  const met = (weekStart: string): boolean => {
    const end = addHabitDays(weekStart, 6);
    let count = 0;
    for (const d of done) if (d >= weekStart && d <= end) count += 1;
    return count >= targetFor(weekStart);
  };

  const floorWeek = habitWeekStart(earliestDay(done, today));
  const currentWeek = habitWeekStart(today);

  // Current: an unmet current week is in progress (skip it, do not break); earlier weeks must be met.
  let current = 0;
  let w = met(currentWeek) ? currentWeek : addHabitDays(currentWeek, -7);
  while (w >= floorWeek) {
    if (!met(w)) break;
    current += 1;
    w = addHabitDays(w, -7);
  }

  let longest = 0;
  let run = 0;
  for (let wk = floorWeek; wk <= currentWeek; wk = addHabitDays(wk, 7)) {
    if (met(wk)) {
      run += 1;
      if (run > longest) longest = run;
    } else if (wk !== currentWeek) {
      run = 0;
    }
  }
  return { current, longest: Math.max(longest, current) };
}

/**
 * Current and longest streak for an item, judged by the schedule in force on each period (D-095):
 * consecutive done due days for a days-of-week habit, consecutive weeks meeting N for a per-week
 * habit. Extras never count, not-due days never break, and the unfinished current period never
 * breaks it. The period model follows the kind in force today.
 */
export function streak(
  schedules: HabitSchedule[],
  completionDays: Iterable<string>,
  today: string,
): StreakResult {
  const done = new Set<string>(completionDays);
  const kind = scheduleForDay(schedules, today)?.kind ?? 'days_of_week';
  return kind === 'per_week'
    ? perWeekStreak(schedules, done, today)
    : daysOfWeekStreak(schedules, done, today);
}

/** A short human label for a schedule, for the Habits tab ("Every day", "Mon, Wed, Fri", "3× per week"). */
export function scheduleLabel(schedule: HabitSchedule | null): string {
  if (!schedule || (schedule.kind === 'days_of_week' && maskOf(schedule) === DAYS_OF_WEEK_ALL)) {
    return 'Every day';
  }
  if (schedule.kind === 'per_week') {
    return `${schedule.perWeekN ?? 1}× per week`;
  }
  const mask = maskOf(schedule);
  return HABIT_WEEKDAY_NAMES.filter((_, i) => weekdayInMask(mask, i)).join(', ');
}

/* ── Sets: nested habits and derived state (PD-723) ──────────────────────────────────
 *
 * A **set** is a habit with children, nested to any depth (glossary: Set, Set progress). Set-ness is
 * structural — an item is a set exactly when it has children — so there is no stored flag. Schedules
 * live on leaf habits only; a set derives everything from its subtree:
 *   - due on a day  ⇔ any child is due that day;
 *   - done on a day ⇔ it is due and every due child is done, recursively;
 *   - progress      = due children done / due children, a nested set counting as one child;
 *   - streak        = {@link dailyStreak} over the set's own derived due/done days.
 * Metrics never count toward a set (never due, never done here; PD-724 keeps them out of progress).
 *
 * All of this is pure so the server (the Today view, D-095) and the client (optimistic ticking)
 * agree. Two node shapes: {@link HabitDayNode} carries one day's leaf state for the due/done/progress
 * trio, and {@link HabitHistoryNode} carries full leaf history for {@link setStreak}. */

/** Progress through a set on one day: due children done out of due children. */
export interface SetProgress {
  done: number;
  total: number;
}

/**
 * A node for deriving a set's state on ONE day. A leaf carries its own `due`/`done` for that day; a
 * set ignores them and derives from `children`.
 */
export interface HabitDayNode {
  kind: HabitItemKind;
  children: HabitDayNode[];
  /** Leaf only: is this habit due on the day? */
  due: boolean;
  /** Leaf only: is this habit completed on the day? */
  done: boolean;
}

/** True when the node has children — the structural definition of a set. */
export function isSetNode(node: HabitDayNode): boolean {
  return node.children.length > 0;
}

/** Whether the node is due on its day: a leaf by its own `due`, a set when any child is due. */
export function nodeDue(node: HabitDayNode): boolean {
  if (node.kind === 'metric') return false;
  if (isSetNode(node)) return node.children.some(nodeDue);
  return node.due;
}

/**
 * Whether the node is done on its day: a leaf by its own `done`, a set when it is due and every due
 * child is done (recursively). A set with no due child is not done.
 */
export function nodeDone(node: HabitDayNode): boolean {
  if (node.kind === 'metric') return false;
  if (isSetNode(node)) {
    const due = node.children.filter(nodeDue);
    return due.length > 0 && due.every(nodeDone);
  }
  return node.done;
}

/** A set's progress on its day: due children done over due children, a nested set counting as one. */
export function nodeProgress(node: HabitDayNode): SetProgress {
  const due = node.children.filter((c) => c.kind !== 'metric' && nodeDue(c));
  return { done: due.filter(nodeDone).length, total: due.length };
}

/** A node for deriving a set's streak: full leaf schedule + completion history for its subtree. */
export interface HabitHistoryNode {
  kind: HabitItemKind;
  children: HabitHistoryNode[];
  /** Leaf only: the item's effective-dated schedules. */
  schedules: HabitSchedule[];
  /** Leaf only: the days the item was completed. */
  completionDays: ReadonlySet<string>;
}

/** Project a history node to its single-day {@link HabitDayNode} on `day`, for due/done derivation. */
export function projectHabitDay(node: HabitHistoryNode, day: string): HabitDayNode {
  const leaf = node.children.length === 0;
  return {
    kind: node.kind,
    children: node.children.map((c) => projectHabitDay(c, day)),
    due: leaf ? isDue(node.schedules, day) : false,
    done: leaf ? node.completionDays.has(day) : false,
  };
}

function earliestHistoryDay(node: HabitHistoryNode, fallback: string): string {
  let min: string | null = null;
  const visit = (n: HabitHistoryNode): void => {
    for (const d of n.completionDays) if (min === null || d < min) min = d;
    n.children.forEach(visit);
  };
  visit(node);
  return min ?? fallback;
}

/**
 * A set's current/longest streak (PD-723): {@link dailyStreak} over the set's own derived due/done
 * days. A day counts when the set is due and done, a not-due day neither counts nor breaks, and an
 * unfinished due today does not break it. Judged day-by-day through {@link projectHabitDay}, so an
 * effective-dated schedule change on any leaf is honoured.
 */
export function setStreak(node: HabitHistoryNode, today: string): StreakResult {
  const floor = earliestHistoryDay(node, today);
  const dueOn = (day: string): boolean => nodeDue(projectHabitDay(node, day));
  const doneOn = (day: string): boolean => nodeDone(projectHabitDay(node, day));
  return dailyStreak(dueOn, doneOn, today, floor);
}

/* ── Completion rate (PD-726, D-102 header stats) ───────────────────────────────────
 *
 * The By Habit view's header shows, beside the streak, a completion rate "over the last N due
 * periods" (spec §3). Semantics are settled in D-102: a due period is a due **day** for a
 * days-of-week habit (and for a set, whose due/done are derived), and a **week** for a per-week
 * habit — the same period model the streak functions use, so the two figures stay consistent. The
 * current period, if it is still in progress (due today but not yet done, or an unmet current week),
 * is excluded exactly as the streak treats it: it is neither a success nor a miss until it closes.
 * History is floored at the earliest completion, the way the streak functions floor, so a habit's
 * untracked past is never counted as a run of misses. */

export interface CompletionRate {
  /** Periods met in the window. */
  done: number;
  /** Due periods in the window (≤ the requested count). */
  total: number;
  /** done / total, or null when the window holds no closed due period. */
  rate: number | null;
}

/** Default window: the last 30 due periods (spec §3). */
export const COMPLETION_RATE_PERIODS = 30;

/** The rate over the last `periods` daily due periods, parameterised by due/done like `dailyStreak`. */
function dailyRate(
  dueOn: (day: string) => boolean,
  doneOn: (day: string) => boolean,
  today: string,
  floor: string,
  periods: number,
): CompletionRate {
  const dueDays: string[] = [];
  for (let d = floor; d <= today; d = addHabitDays(d, 1)) {
    if (!dueOn(d)) continue;
    if (d === today && !doneOn(d)) continue; // the current period is still in progress
    dueDays.push(d);
  }
  const recent = dueDays.slice(-periods);
  const done = recent.filter(doneOn).length;
  return { done, total: recent.length, rate: recent.length > 0 ? done / recent.length : null };
}

function daysOfWeekRate(
  schedules: HabitSchedule[],
  done: Set<string>,
  today: string,
  periods: number,
): CompletionRate {
  const dueOn = (day: string): boolean => weekdayInMask(maskOf(scheduleForDay(schedules, day)), habitWeekday(day));
  return dailyRate(dueOn, (d) => done.has(d), today, earliestDay(done, today), periods);
}

function perWeekRate(
  schedules: HabitSchedule[],
  done: Set<string>,
  today: string,
  periods: number,
): CompletionRate {
  const targetFor = (weekStart: string): number => scheduleForDay(schedules, weekStart)?.perWeekN ?? 1;
  const met = (weekStart: string): boolean => {
    const end = addHabitDays(weekStart, 6);
    let count = 0;
    for (const d of done) if (d >= weekStart && d <= end) count += 1;
    return count >= targetFor(weekStart);
  };
  const floorWeek = habitWeekStart(earliestDay(done, today));
  const currentWeek = habitWeekStart(today);
  const weeks: boolean[] = [];
  for (let wk = floorWeek; wk <= currentWeek; wk = addHabitDays(wk, 7)) {
    if (wk === currentWeek && !met(wk)) continue; // current week still in progress
    weeks.push(met(wk));
  }
  const recent = weeks.slice(-periods);
  const doneCount = recent.filter(Boolean).length;
  return { done: doneCount, total: recent.length, rate: recent.length > 0 ? doneCount / recent.length : null };
}

/**
 * A leaf habit's completion rate over the last `periods` due periods, judged by the schedule in force
 * on each period (D-095): due days for a days-of-week habit, weeks meeting N for a per-week habit.
 * Mirrors {@link streak}'s period model so the header's two figures agree.
 */
export function completionRate(
  schedules: HabitSchedule[],
  completionDays: Iterable<string>,
  today: string,
  periods: number = COMPLETION_RATE_PERIODS,
): CompletionRate {
  const done = new Set<string>(completionDays);
  const kind = scheduleForDay(schedules, today)?.kind ?? 'days_of_week';
  return kind === 'per_week'
    ? perWeekRate(schedules, done, today, periods)
    : daysOfWeekRate(schedules, done, today, periods);
}

/**
 * A set's completion rate over the last `periods` derived due days (PD-723 period model), mirroring
 * {@link setStreak}: a day counts as due/done by the set's own derived state, judged day-by-day
 * through {@link projectHabitDay} so effective-dated leaf schedules are honoured.
 */
export function setCompletionRate(
  node: HabitHistoryNode,
  today: string,
  periods: number = COMPLETION_RATE_PERIODS,
): CompletionRate {
  const floor = earliestHistoryDay(node, today);
  const dueOn = (day: string): boolean => nodeDue(projectHabitDay(node, day));
  const doneOn = (day: string): boolean => nodeDone(projectHabitDay(node, day));
  return dailyRate(dueOn, doneOn, today, floor, periods);
}

/* ── By Habit calendar layout (PD-726) ──────────────────────────────────────────────
 *
 * The By Habit calendar is a grid of habit-week rows (Mon–Sun), newest at the bottom, with month
 * names in a left gutter. These pure helpers turn a window of weeks into the row set to render and
 * the month spans for the gutter, so the geometry is unit-testable away from the DOM. */

/** Short month abbreviations for the calendar's left gutter (Jan … Dec), indexed by month-1. */
export const HABIT_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Full month names (January … December), indexed by month-1 — the By Day grid's month row. */
export const HABIT_MONTH_FULL_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * The `count` habit-week starts ending at (and including) `lastWeekStart`, oldest first — the rows
 * the calendar renders top-to-bottom with the newest week at the bottom. `count ≤ 0` yields `[]`.
 */
export function habitWeeksEndingAt(lastWeekStart: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(addHabitDays(lastWeekStart, -7 * i));
  return out;
}

/** A month's vertical span in the gutter: the rows (week indices) its days occupy, inclusive. */
export interface MonthSpan {
  year: number;
  /** 1–12. */
  month: number;
  /** Short month name, e.g. 'Nov'. */
  monthName: string;
  /** First week row (index into the `weekStarts` passed in) containing a day of this month. */
  startRow: number;
  /** Last week row containing a day of this month. */
  endRow: number;
}

/**
 * The month spans for a run of week rows (each a Mon week-start, oldest first). Walks every day of
 * every week in order, so a month that starts or ends mid-week still spans exactly the rows holding
 * its days — a boundary week belongs to both adjacent months. Returned in chronological order.
 */
export function habitMonthSpans(weekStarts: string[]): MonthSpan[] {
  const byKey = new Map<string, MonthSpan>();
  const order: string[] = [];
  weekStarts.forEach((weekStart, row) => {
    for (let i = 0; i < 7; i += 1) {
      const day = addHabitDays(weekStart, i);
      const [year, month] = day.split('-').map(Number);
      const key = `${year}-${month}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.endRow = row;
      } else {
        byKey.set(key, { year, month, monthName: HABIT_MONTH_NAMES[month - 1], startRow: row, endRow: row });
        order.push(key);
      }
    }
  });
  return order.map((k) => byKey.get(k) as MonthSpan);
}

/* ── The Today view (server-computed, D-095) ────────────────────────────────────────
 *
 * The server owns full completion history, so it computes each item's due state, per-week progress
 * and streak in one `GET /api/habits/today` payload rather than shipping history to the client. This
 * keeps the client thin and keeps "today" consistent with the server's `habitDay` (D-092). */

/** One active item's standing on the current habit day. */
export interface HabitTodayRow {
  item: HabitItemView;
  /** The schedule in force today, or null (treated as daily). Always null for a set. */
  schedule: HabitSchedule | null;
  /** Whether the item is on Today (per-week items are always on; days-of-week only on due days). */
  due: boolean;
  /** Leaf: completed today. Set: derived done (every due child done). */
  completedToday: boolean;
  /** Non-null only for a per-week leaf item. */
  perWeek: PerWeekProgress | null;
  streak: StreakResult;
  /** True when the item has children (a set, PD-723). */
  isSet: boolean;
  /** Non-null only for a set: due children done / due children today. */
  progress: SetProgress | null;
}

export interface HabitTodayView {
  /** The current habit day the rows were computed for. */
  day: string;
  rows: HabitTodayRow[];
  /** Active metrics, with today's value and (for choice) their options (PD-724). */
  metrics: HabitMetricTodayRow[];
}

/** Input for setting a habit's schedule (applied from today). One kind's fields, the other's null. */
export interface SetHabitScheduleInput {
  kind: HabitScheduleKind;
  daysMask?: number | null;
  perWeekN?: number | null;
}

/** 🔥 is shown on a Today row from this streak length up (spec §2, "from 🔥2 upward"). */
export const STREAK_BADGE_MIN = 2;

/* ── Metrics: typed daily values (PD-724) ───────────────────────────────────────────
 *
 * A **metric** is an optional, typed daily value logged beside the habits (glossary: Metric). It is
 * never due, has no streak, and never counts toward a set's progress. Its `metricType` fixes how its
 * value is shaped and, once a value exists, cannot change (enforced in the store):
 *   - `time`   → a wall-clock time of day, `'HH:MM'` (e.g. "Morning Routine Done By");
 *   - `number` → a decimal string; `"0"` is a logged zero, distinct from null / not-logged (drinks);
 *   - `choice` → a JSON array of `habit_choice_options` ids the user picked that day (Drugs).
 *
 * The value always travels as a **string** (or null = cleared), so one `(item, day)` set-state
 * message (PROJECT.md §4) carries every type and the offline outbox stays type-agnostic. These
 * validators are pure so the server (the metric route) and the client (optimistic logging) agree. */

/** One logged metric value on one habit day. PK is `(itemId, day)`. A missing row = not logged. */
export interface HabitMetricValue {
  itemId: number;
  /** A habit day `YYYY-MM-DD`. */
  day: string;
  /** `'HH:MM'` | a decimal string | a JSON array of option ids. Never the empty string. */
  value: string;
  /** Unix ms the value was last written. */
  updatedAt: number;
}

/** One selectable option of a `choice` metric. One row of `habit_choice_options`. */
export interface HabitChoiceOption {
  id: number;
  itemId: number;
  label: string;
  /** Manual order among the metric's options, ascending. */
  sortOrder: number;
  /** Unix ms when archived (kept for history), or null while active. */
  archivedAt: number | null;
}

/** One active metric's standing on the current habit day — what the Today view carries per metric. */
export interface HabitMetricTodayRow {
  item: HabitItemView;
  /** Today's logged value, or null when not logged (distinct from a logged `"0"`). */
  value: string | null;
  /** The metric's active options, in order. Empty for `time` / `number`. */
  options: HabitChoiceOption[];
}

/** `HH:MM`, 24-hour. */
export const HABIT_TIME_VALUE_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeValue(value: unknown): value is string {
  return typeof value === 'string' && HABIT_TIME_VALUE_PATTERN.test(value);
}

/** A number metric value: a non-empty decimal string of a finite number. `"0"` is valid and logged. */
export function isValidNumberValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

/**
 * Parse a choice metric value (a JSON array of option ids) into the id list, or null when it is not
 * a JSON array of integers. An empty array is valid (parses to `[]`). Membership of the ids in the
 * metric's own options is checked by the store, which holds them.
 */
export function parseChoiceValue(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n))) return null;
  return parsed as number[];
}

/** Serialise a choice selection to its stored value. */
export function choiceValue(optionIds: number[]): string {
  return JSON.stringify(optionIds);
}

/**
 * Whether `value` is well-formed for a metric of `type`, ignoring choice-option membership (the store
 * checks that). A format gate shared by the client and the server; `null` (cleared) is handled by the
 * caller, not here.
 */
export function isValidMetricValueFormat(type: HabitMetricType, value: unknown): boolean {
  switch (type) {
    case 'time':
      return isValidTimeValue(value);
    case 'number':
      return isValidNumberValue(value);
    case 'choice':
      return parseChoiceValue(value) !== null;
  }
}

export const HABIT_CHOICE_LABEL_MAX_LENGTH = 100;
