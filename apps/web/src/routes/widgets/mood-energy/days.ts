import {
  MOOD_ENERGY_DEFAULT_VALUE,
  DEFAULT_DAY_BOUNDARY_MINUTES,
  DEFAULT_HABIT_TIMEZONE,
  habitDay,
  isValidDayBoundaryMinutes,
  isValidTimezone,
  type HabitSettings,
  type MoodEnergyEntry,
} from '@dashboard/shared';
import type { PendingSave } from './queue';

/**
 * Day logic for Mood & Energy: which habit day "today" is, and how the outbox's unsent saves fold
 * over the entries from the server. Pure, so it is unit-tested without the DOM.
 *
 * A day is the Habit Tracker's habit day (D-092): its day boundary and timezone, fetched from the
 * habit settings API and cached on the device so the right day is still known offline.
 */

export const SETTINGS_CACHE_KEY = 'mood-energy:habit-settings';

export const DEFAULT_SETTINGS: HabitSettings = {
  dayBoundaryMinutes: DEFAULT_DAY_BOUNDARY_MINUTES,
  timezone: DEFAULT_HABIT_TIMEZONE,
};

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Validated settings from untrusted JSON (the cache), or null. */
export function parseSettings(raw: unknown): HabitSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { dayBoundaryMinutes, timezone } = raw as Record<string, unknown>;
  if (!isValidDayBoundaryMinutes(dayBoundaryMinutes) || !isValidTimezone(timezone)) return null;
  return { dayBoundaryMinutes, timezone };
}

/** The cached habit settings, else the shared defaults. */
export function loadCachedSettings(kv: KV | null = storage()): HabitSettings {
  try {
    const raw = kv?.getItem(SETTINGS_CACHE_KEY);
    return (raw ? parseSettings(JSON.parse(raw)) : null) ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function cacheSettings(settings: HabitSettings, kv: KV | null = storage()): void {
  try {
    kv?.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // per-device convenience only
  }
}

/** An entry as the page shows it: from the server, or (`pending`) a save still in the outbox. */
export interface DayEntry extends MoodEnergyEntry {
  pending?: boolean;
}

/** The day a queued save is for: its explicit day (a backfill), else the habit day of its time. */
export function pendingDay(p: PendingSave, settings: HabitSettings): string {
  return p.day ?? habitDay(p.recordedAt, settings);
}

/** Newest day first, one per day. Incoming entries replace any with the same day. */
export function mergeEntries<T extends MoodEnergyEntry>(entries: T[], incoming: T[]): T[] {
  const days = new Set(incoming.map((e) => e.day));
  return [...entries.filter((e) => !days.has(e.day)), ...incoming].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * The server's entries with the outbox's unsent saves folded over them, last save per day winning —
 * exactly what the server will hold once they sync. A pending day keeps its server id (so it can
 * still be deleted) and is marked `pending`.
 */
export function overlayPending(entries: MoodEnergyEntry[], pending: PendingSave[], settings: HabitSettings): DayEntry[] {
  const byDay = new Map<string, DayEntry>(entries.map((e) => [e.day, e]));
  for (const p of pending) {
    const day = pendingDay(p, settings);
    const base = byDay.get(day);
    byDay.set(day, {
      id: base?.id ?? -1,
      day,
      recordedAt: p.recordedAt,
      mood: p.mood,
      energy: p.energy,
      tags: [...p.tags].sort(),
      note: p.note ?? null,
      createdAt: base?.createdAt ?? p.recordedAt,
      updatedAt: p.recordedAt,
      pending: true,
    });
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** "Tuesday" for a habit day (calendar arithmetic in UTC, so the device's zone can't shift it). */
export function weekdayName(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** "Tue 17 Nov" for a habit day; with `year`, "Tue 17 Nov 2026". */
export function formatDay(day: string, opts: { year?: boolean } = {}): string {
  const d = new Date(`${day}T12:00:00Z`);
  const base = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return opts.year ? `${base} ${d.getUTCFullYear()}` : base;
}

/** The form's fields for one day. */
export interface DayDraft {
  mood: number;
  energy: number;
  tags: string[];
  note: string;
}

/** A new day: both sliders at the midpoint, no tags, no note. */
export function blankDraft(): DayDraft {
  return { mood: MOOD_ENERGY_DEFAULT_VALUE, energy: MOOD_ENERGY_DEFAULT_VALUE, tags: [], note: '' };
}

export function draftFromEntry(e: MoodEnergyEntry | null): DayDraft {
  return e ? { mood: e.mood, energy: e.energy, tags: [...e.tags], note: e.note ?? '' } : blankDraft();
}
