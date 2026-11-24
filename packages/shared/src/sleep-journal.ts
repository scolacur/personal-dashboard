/**
 * Sleep Journal — shared types, validation and wall-clock helpers (see
 * `widgets/sleep-journal/PROJECT.md`).
 *
 * An entry is a **night**, one per wake date: the local calendar date (America/New_York) of the
 * wake time. Saving a night whose wake date already has an entry updates that entry, so the wake
 * date — not the client id — is the natural key; the client id only makes an offline replay safe.
 */

import { DEFAULT_HABIT_TIMEZONE } from './habits';

export const SLEEP_RESTED_MIN = 1;
export const SLEEP_RESTED_MAX = 5;
/** Where the rested slider starts, every time. */
export const SLEEP_RESTED_DEFAULT = 3;

/** Seeded into the tag cloud on first boot. Further tags are user-created. */
export const SLEEP_DEFAULT_TAGS = ['Magnesium', 'Ashwagandha', 'Melatonin'] as const;

export const SLEEP_TAG_MAX_LENGTH = 32;
export const SLEEP_NOTES_MAX_LENGTH = 4000;
export const SLEEP_TAG_COUNT_MIN = 1;
export const SLEEP_TAG_COUNT_MAX = 20;

/** The longest a night may be. Anything longer is a typo (a wrong date), not a sleep. */
export const SLEEP_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** How far ahead of the server's clock a wake time may be: phone clock drift, nothing more. */
export const SLEEP_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Wake dates and times of day are read in this zone, the same home zone as the Habit Tracker. */
export const SLEEP_TIMEZONE = DEFAULT_HABIT_TIMEZONE;

/** Where a sleep defaults to when there's no previous night to copy it from. */
export const SLEEP_DEFAULT_SLEEP_TIME = '23:00';

export interface SleepTag {
  id: number;
  name: string;
  /** Unix ms. Null for a tag shown in the cloud; set when hidden. Past entries keep it either way. */
  hiddenAt: number | null;
  createdAt: number;
}

/** A counted tag on a night: "Magnesium ×2". */
export interface SleepTagCount {
  name: string;
  /** Whole number, {@link SLEEP_TAG_COUNT_MIN}–{@link SLEEP_TAG_COUNT_MAX}. */
  count: number;
}

export interface SleepEntry {
  id: number;
  /** The client id that first created the night. Later upserts' ids are remembered server-side. */
  clientId: string;
  /** `YYYY-MM-DD`: the local date of `wakeAt`. Unique. */
  wakeDate: string;
  /** Unix ms: when I went to sleep. */
  sleepAt: number;
  /** Unix ms: when I woke. */
  wakeAt: number;
  rested: number;
  /** Sorted by name. */
  tags: SleepTagCount[];
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSleepEntryInput {
  clientId: string;
  sleepAt: number;
  wakeAt: number;
  rested: number;
  /** Unknown names are created; hidden ones are un-hidden. */
  tags: SleepTagCount[];
  notes?: string | null;
}

export interface UpdateSleepEntryInput {
  sleepAt?: number;
  wakeAt?: number;
  rested?: number;
  tags?: SleepTagCount[];
  notes?: string | null;
}

export function isValidRested(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= SLEEP_RESTED_MIN && v <= SLEEP_RESTED_MAX;
}

export function isValidTagCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= SLEEP_TAG_COUNT_MIN && v <= SLEEP_TAG_COUNT_MAX;
}

/**
 * Trim and collapse internal whitespace. Case is kept ("Magnesium" reads better than
 * "magnesium"); the database compares names case-insensitively, so the first spelling wins.
 */
export function normalizeSleepTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Steve's rested rubric. Index = score; 0 is unused. */
export const SLEEP_RUBRIC: readonly (string | null)[] = [null, 'Wrecked', 'Groggy', 'Okay', 'Solid', 'Quite Rested'];

export function sleepRestedLabel(rested: number): string | null {
  return SLEEP_RUBRIC[rested] ?? null;
}

/**
 * The rested colour scale, red (1) to green (5). Mid-tone hues, so they read on both the light and
 * dark themes, and dark ink reads on all of them. Used by the slider, calendar, list and trends.
 */
export const SLEEP_RESTED_COLORS: Readonly<Record<number, string>> = {
  1: '#d64541',
  2: '#ec8a3c',
  3: '#e3c13b',
  4: '#9ccc5a',
  5: '#3fae68',
};

/** Ink for text drawn on a rested colour. */
export const SLEEP_RESTED_INK = '#1f1f1f';

export function sleepRestedColor(rested: number): string {
  return SLEEP_RESTED_COLORS[rested] ?? SLEEP_RESTED_COLORS[SLEEP_RESTED_DEFAULT];
}

/* ── Wall clock ───────────────────────────────────────────────────────────────────────
 *
 * The journal speaks in wall-clock terms ("23:10", "Tue 24 Nov") in one home zone, so every
 * device agrees on which night a wake time belongs to.
 */

const pad2 = (n: number) => String(n).padStart(2, '0');

export interface WallClock {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Minutes past local midnight, 0–1439. */
  minutes: number;
}

/** The local date and minutes-past-midnight of an instant in `timeZone`. */
export function sleepWallClock(ms: number, timeZone: string = SLEEP_TIMEZONE): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    date: `${get('year')}-${pad2(get('month'))}-${pad2(get('day'))}`,
    minutes: (get('hour') % 24) * 60 + get('minute'),
  };
}

/** The wake date a wake time belongs to. */
export function sleepWakeDate(wakeAt: number, timeZone: string = SLEEP_TIMEZONE): string {
  return sleepWallClock(wakeAt, timeZone).date;
}

/**
 * The instant at wall-clock `minutes` past midnight on `date` in `timeZone`. A time that a DST
 * change skips or repeats resolves to the earlier of the two candidate instants.
 */
export function sleepInstantAt(date: string, minutes: number, timeZone: string = SLEEP_TIMEZONE): number {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Offset of the zone at an instant: wall clock minus UTC, in ms.
  const offsetAt = (ms: number) => {
    const wc = sleepWallClock(ms, timeZone);
    const [wy, wm, wd] = wc.date.split('-').map(Number);
    return Date.UTC(wy, wm - 1, wd, Math.floor(wc.minutes / 60), wc.minutes % 60) - Math.floor(ms / 60_000) * 60_000;
  };
  // Two passes settle it: the first guess may sit on the far side of a DST change.
  const first = naive - offsetAt(naive);
  const second = naive - offsetAt(first);
  return Math.min(first, second);
}

/** A calendar date `delta` days from `date` (calendar arithmetic, in UTC, so no DST leaks in). */
export function addSleepDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * Turn a night's wall-clock inputs into instants. The wake time is on `wakeDate`; the sleep time is
 * on the same date if it is earlier in the day than the wake time, otherwise the evening before
 * (23:10 → 06:45 is the previous evening; 01:30 → 08:00 is the same date).
 */
export function sleepNightInstants(
  wakeDate: string,
  sleepMinutes: number,
  wakeMinutes: number,
  timeZone: string = SLEEP_TIMEZONE,
): { sleepAt: number; wakeAt: number } {
  const sleepDate = sleepMinutes < wakeMinutes ? wakeDate : addSleepDays(wakeDate, -1);
  return {
    sleepAt: sleepInstantAt(sleepDate, sleepMinutes, timeZone),
    wakeAt: sleepInstantAt(wakeDate, wakeMinutes, timeZone),
  };
}
