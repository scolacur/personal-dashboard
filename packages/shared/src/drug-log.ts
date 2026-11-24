/**
 * Drug Log — shared types and constants (see `widgets/drug-log/PROJECT.md`). PD-975 (Drug log
 * widget).
 *
 * A tap-counter: one round button per drug, and each tap is an **event** stamped with the moment it
 * happened. Many events per day, so they live in the widget's own `drug_log_*` tables.
 */
import { DEFAULT_DAY_BOUNDARY_MINUTES, DEFAULT_HABIT_TIMEZONE, type HabitSettings } from './habits';

/** A button's inner copy must fit in a circle; past this it would be unreadable. */
export const DRUG_LOG_LABEL_MAX_LENGTH = 12;

/** Same rule as the Tinnitus Tracker: a little phone clock drift, never the future. */
export const DRUG_LOG_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Seeded once, on the first boot that finds no drugs. Never re-seeded after it is deleted. */
export const DRUG_LOG_DEFAULT_DRUG = { label: 'Weed', color: '#2e9e5b' } as const;

/**
 * What "a day" means here: a **habit day**, using the Habit Tracker's own settings (day boundary
 * and home timezone, from the shared habit store — D-092), so a 2am tap counts toward the evening
 * before and every widget agrees on which day an event belongs to. The server sends the live
 * settings with `GET /drugs`; this is only the fallback for a device that has never reached it.
 */
export const DRUG_LOG_FALLBACK_DAY_SETTINGS: HabitSettings = {
  dayBoundaryMinutes: DEFAULT_DAY_BOUNDARY_MINUTES,
  timezone: DEFAULT_HABIT_TIMEZONE,
};

/** `GET /drugs`: every drug (archived included) plus the habit-day settings to bucket events by. */
export interface DrugLogDrugsResponse {
  drugs: DrugLogDrug[];
  daySettings: HabitSettings;
}

export interface DrugLogDrug {
  id: number;
  label: string;
  /** Canonical `#rrggbb`. */
  color: string;
  sortOrder: number;
  /** Unix ms; null while the button is on the grid. Archived drugs keep their history. */
  archivedAt: number | null;
  createdAt: number;
  /** How many events this drug has — for the delete confirmation. */
  eventCount: number;
}

export interface DrugLogEvent {
  id: number;
  /** Client-generated, so the offline outbox can replay a tap without logging it twice. */
  clientId: string;
  drugId: number;
  /** Unix ms: when the tap happened (or the re-timed moment). */
  recordedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDrugLogDrugInput {
  label: string;
  color: string;
}

export interface UpdateDrugLogDrugInput {
  label?: string;
  color?: string;
  sortOrder?: number;
  archived?: boolean;
}

export interface CreateDrugLogEventInput {
  clientId: string;
  drugId: number;
  recordedAt: number;
}

export interface UpdateDrugLogEventInput {
  recordedAt?: number;
  drugId?: number;
}

/** Trim and collapse internal whitespace. Case is kept: "MDMA" and "Weed" are both fine. */
export function normalizeDrugLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}
