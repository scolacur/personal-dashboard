import {
  sleepNightInstants,
  SLEEP_DEFAULT_SLEEP_TIME,
  SLEEP_FUTURE_TOLERANCE_MS,
  SLEEP_RESTED_DEFAULT,
  type SleepEntry,
  type SleepTagCount,
} from '@dashboard/shared';
import { formatClock, fromTimeInput, minutesOf, roundDownToFive, todayWakeDate, toTimeInput } from './time';

/**
 * The capture form's state, as the inputs hold it, and its conversion to a night. Pure, so the
 * "previous evening" rule and the defaults are unit-tested here rather than in a component.
 */
export interface NightDraft {
  /** `YYYY-MM-DD`: the wake date. Defaults to today. */
  wakeDate: string;
  /** `HH:MM`. */
  sleepTime: string;
  /** `HH:MM`. */
  wakeTime: string;
  rested: number;
  /** Tag name → count, for each tag that is on. */
  counts: Record<string, number>;
  notes: string;
}

/**
 * A fresh night: waking today, now (rounded down to 5 min); asleep at the previous night's time of
 * day, else 23:00; rested 3; no tags or notes.
 */
export function blankDraft(previous: SleepEntry | null, now = Date.now()): NightDraft {
  return {
    wakeDate: todayWakeDate(now),
    sleepTime: previous ? formatClock(previous.sleepAt) : SLEEP_DEFAULT_SLEEP_TIME,
    wakeTime: toTimeInput(roundDownToFive(minutesOf(now))),
    rested: SLEEP_RESTED_DEFAULT,
    counts: {},
    notes: '',
  };
}

export function draftFromEntry(e: SleepEntry): NightDraft {
  return {
    wakeDate: e.wakeDate,
    sleepTime: formatClock(e.sleepAt),
    wakeTime: formatClock(e.wakeAt),
    rested: e.rested,
    counts: countsFromTags(e.tags),
    notes: e.notes ?? '',
  };
}

export function countsFromTags(tags: SleepTagCount[]): Record<string, number> {
  return Object.fromEntries(tags.map((t) => [t.name, t.count]));
}

export function tagsFromCounts(counts: Record<string, number>): SleepTagCount[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type DraftTimes = { ok: true; sleepAt: number; wakeAt: number } | { ok: false; error: string };

/**
 * The draft's instants. The sleep time is the evening before unless it is earlier in the day than
 * the wake time (see `sleepNightInstants`).
 */
export function draftTimes(d: Pick<NightDraft, 'wakeDate' | 'sleepTime' | 'wakeTime'>, now = Date.now()): DraftTimes {
  const sleepMin = fromTimeInput(d.sleepTime);
  const wakeMin = fromTimeInput(d.wakeTime);
  if (sleepMin === null || wakeMin === null) return { ok: false, error: 'Pick a sleep and a wake time.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.wakeDate)) return { ok: false, error: 'Pick a valid date.' };
  const { sleepAt, wakeAt } = sleepNightInstants(d.wakeDate, sleepMin, wakeMin);
  if (wakeAt > now + SLEEP_FUTURE_TOLERANCE_MS) return { ok: false, error: "That wake time hasn't happened yet." };
  return { ok: true, sleepAt, wakeAt };
}
