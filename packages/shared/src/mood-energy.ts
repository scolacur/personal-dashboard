/**
 * Mood & Energy — shared types, rubrics and validation (see `widgets/mood-energy/PROJECT.md`).
 *
 * An entry is a **day**: one per habit day, keyed by the Habit Tracker's day boundary and timezone
 * (`habitDay`, D-092), so a 1am check-in counts toward the day before. Saving again for the same day
 * updates it. Entries live in the widget's own `mood_energy_*` tables.
 */

export const MOOD_ENERGY_MIN = 1;
export const MOOD_ENERGY_MAX = 5;
/** Where both sliders start for a day with no entry yet. */
export const MOOD_ENERGY_DEFAULT_VALUE = 3;

/** Seeded into the feeling-tag cloud on first boot. Further tags are user-created. */
export const MOOD_ENERGY_DEFAULT_TAGS = ['calm', 'anxious', 'irritable', 'focused', 'sad', 'grateful'] as const;

export const MOOD_ENERGY_TAG_MAX_LENGTH = 32;
export const MOOD_ENERGY_NOTE_MAX_LENGTH = 2000;

/** How far ahead of the server's clock a `recordedAt` may be: phone clocks drift a little. */
export const MOOD_ENERGY_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Mood rubric. Index = value; 0 is unused. */
export const MOOD_RUBRIC: readonly (string | null)[] = [
  null,
  'Unpleasant',
  'Slightly Unpleasant',
  'Neutral',
  'Pleasant',
  'Very Pleasant',
];

/** Energy rubric. Index = value; 0 is unused. */
export const ENERGY_RUBRIC: readonly (string | null)[] = [null, 'Drained', 'Low', 'Steady', 'Energized', 'Very Energized'];

export function moodLabel(value: number): string | null {
  return MOOD_RUBRIC[value] ?? null;
}

export function energyLabel(value: number): string | null {
  return ENERGY_RUBRIC[value] ?? null;
}

export function isValidMoodEnergyValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MOOD_ENERGY_MIN && v <= MOOD_ENERGY_MAX;
}

export interface MoodEnergyTag {
  id: number;
  name: string;
  /** Unix ms. Null for a tag shown in the cloud; set when hidden. Past entries keep it either way. */
  hiddenAt: number | null;
  createdAt: number;
}

export interface MoodEnergyEntry {
  id: number;
  /** The habit day this entry is for, `YYYY-MM-DD`. Unique. */
  day: string;
  /** Unix ms of the last save. */
  recordedAt: number;
  mood: number;
  energy: number;
  /** Feeling-tag names, sorted. */
  tags: string[];
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * `POST /entries`: an upsert by day. Without `day`, the server derives it from `recordedAt` and the
 * habit settings; with one (a backfill), that day is used.
 */
export interface SaveMoodEnergyEntryInput {
  /** Client-generated, so the outbox can replay a save whose response was lost without effect. */
  clientId: string;
  /** Unix ms of the save. */
  recordedAt: number;
  day?: string;
  mood: number;
  energy: number;
  /** Tag names. Unknown names are created; hidden ones are un-hidden. */
  tags: string[];
  note?: string | null;
}

export interface UpdateMoodEnergyEntryInput {
  mood?: number;
  energy?: number;
  tags?: string[];
  note?: string | null;
}

/**
 * The energy ramp: one hue, dim slate (1) to bright blue (5), so it never reads as the red→green
 * mood scale (`SCALE_1_5_COLORS`). Mid-tones, legible on both themes' surfaces.
 */
export const ENERGY_COLORS: Readonly<Record<number, string>> = {
  1: '#8a96a8',
  2: '#7895c2',
  3: '#5b92d8',
  4: '#3d8bec',
  5: '#1f84ff',
};

export function energyColor(value: number): string {
  return ENERGY_COLORS[value] ?? ENERGY_COLORS[MOOD_ENERGY_DEFAULT_VALUE];
}
