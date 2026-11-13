/**
 * Tinnitus Tracker — shared types and validation (see `widgets/tinnitus-tracker/PROJECT.md`).
 *
 * An entry is an **event**: many per day, each stamped with the moment it describes. That is why
 * these live in the widget's own `tinnitus_tracker_*` tables and not in the shared one-row-per-day
 * daily-log store (D-090). Correlating the two is PD-706's job.
 */

export const TINNITUS_MIN = 0;
export const TINNITUS_MAX = 10;

/** Seeded into the tag cloud on first boot. Further tags are user-created. */
export const TINNITUS_DEFAULT_TAGS = ['weed', 'caffeine', 'alcohol'] as const;

export const TINNITUS_TAG_MAX_LENGTH = 32;
export const TINNITUS_NOTES_MAX_LENGTH = 2000;

/**
 * How far ahead of the server's clock a `recordedAt` may be. Small and non-zero: a phone's clock
 * can drift a little, but an entry is never about the future.
 */
export const TINNITUS_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface TinnitusTag {
  id: number;
  name: string;
  /** Unix ms. Null for a tag shown in the cloud; set when hidden. Past entries keep it either way. */
  hiddenAt: number | null;
  createdAt: number;
}

export interface TinnitusEntry {
  id: number;
  /** Client-generated id, so a queued entry replayed after a dropped response is not duplicated. */
  clientId: string;
  /** Unix ms: when the tinnitus was at this level (the Enter tap, or the backdated override). */
  recordedAt: number;
  intensity: number;
  /** Tag names, sorted. */
  tags: string[];
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTinnitusEntryInput {
  clientId: string;
  recordedAt: number;
  intensity: number;
  /** Tag names. Unknown names are created; hidden ones are un-hidden. */
  tags: string[];
  notes?: string | null;
}

export interface UpdateTinnitusEntryInput {
  recordedAt?: number;
  intensity?: number;
  tags?: string[];
  notes?: string | null;
}

export function isValidIntensity(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= TINNITUS_MIN && v <= TINNITUS_MAX;
}

/** Trim and collapse internal whitespace; lowercase so "Caffeine" and "caffeine" are one tag. */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Steve's intensity rubric (PD-711). Index = intensity. 0 has no label: "no tinnitus" needs no
 * description.
 */
export const TINNITUS_RUBRIC: readonly (string | null)[] = [
  null,
  'Faint',
  'Faint',
  'Noticeable & maskable',
  'Noticeable & not maskable',
  'Distracting',
  'Very Distracting',
  'Painful',
  'Very Painful',
  'Debilitating',
  'Unbearable',
];

export function tinnitusLabel(intensity: number): string | null {
  return TINNITUS_RUBRIC[intensity] ?? null;
}
