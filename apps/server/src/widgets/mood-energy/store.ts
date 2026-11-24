import type Database from 'better-sqlite3';
import {
  addHabitDays,
  habitDay,
  isHabitDay,
  isValidMoodEnergyValue,
  MOOD_ENERGY_FUTURE_TOLERANCE_MS,
  MOOD_ENERGY_MAX,
  MOOD_ENERGY_MIN,
  MOOD_ENERGY_NOTE_MAX_LENGTH,
  MOOD_ENERGY_TAG_MAX_LENGTH,
  normalizeTagName,
  type HabitSettings,
  type MoodEnergyEntry,
  type MoodEnergyTag,
  type SaveMoodEnergyEntryInput,
  type UpdateMoodEnergyEntryInput,
} from '@dashboard/shared';
import { getSettings } from '../../lib/habits';

/**
 * Mood & Energy store. All SQL lives here; route handlers have none (PROJECT.md §5).
 *
 * Invariants this module owns:
 *  - **One entry per habit day.** The day comes from the Habit Tracker's settings (day boundary +
 *    timezone, read from the shared habit store in `lib/`, D-092), so a 1am save counts toward the
 *    previous day. Saving again for a day updates that day's row.
 *  - **Every save's `clientId` is remembered**, so an outbox replay — of the latest save or an older
 *    one — returns the current row without changing it.
 *  - **Tags by name on the wire, by id in the DB.** An unknown name is created and a hidden one is
 *    un-hidden, so a custom tag added offline still syncs (the Tinnitus Tracker's rule).
 */

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface TagRow {
  id: number;
  name: string;
  hidden_at: number | null;
  created_at: number;
}

interface EntryRow {
  id: number;
  day: string;
  recorded_at: number;
  mood: number;
  energy: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  tags_json: string;
}

function rowToTag(r: TagRow): MoodEnergyTag {
  return { id: r.id, name: r.name, hiddenAt: r.hidden_at, createdAt: r.created_at };
}

function rowToEntry(r: EntryRow): MoodEnergyEntry {
  const tags = (JSON.parse(r.tags_json) as (string | null)[]).filter((t): t is string => t !== null);
  return {
    id: r.id,
    day: r.day,
    recordedAt: r.recorded_at,
    mood: r.mood,
    energy: r.energy,
    tags: tags.sort(),
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ENTRY_SELECT = `
  SELECT e.*,
    (SELECT json_group_array(t.name)
       FROM mood_energy_entry_tags et
       JOIN mood_energy_tags t ON t.id = et.tag_id
      WHERE et.entry_id = e.id) AS tags_json
  FROM mood_energy_entries e`;

/* ── Validation ─────────────────────────────── */

function validTagName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Tag names must be strings.', 'invalid_tag');
  const name = normalizeTagName(raw);
  if (name === '') throw new ValidationError('Tag name is empty.', 'invalid_tag');
  if (name.length > MOOD_ENERGY_TAG_MAX_LENGTH) {
    throw new ValidationError(`Tag names are at most ${MOOD_ENERGY_TAG_MAX_LENGTH} characters.`, 'invalid_tag');
  }
  return name;
}

function validTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ValidationError('tags must be an array of names.', 'invalid_tags');
  return [...new Set(raw.map(validTagName))];
}

function validValue(v: unknown, field: 'mood' | 'energy'): number {
  if (!isValidMoodEnergyValue(v)) {
    throw new ValidationError(
      `${field} must be a whole number from ${MOOD_ENERGY_MIN} to ${MOOD_ENERGY_MAX}.`,
      `invalid_${field}`,
    );
  }
  return v;
}

function validRecordedAt(v: unknown, now: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ValidationError('recordedAt must be a unix-ms timestamp.', 'invalid_recorded_at');
  }
  if (v > now + MOOD_ENERGY_FUTURE_TOLERANCE_MS) {
    throw new ValidationError('recordedAt is in the future.', 'invalid_recorded_at');
  }
  return v;
}

/** A real calendar date (`2026-02-30` is not), no later than today's habit day. */
export function validDay(v: unknown, now: number, settings: HabitSettings): string {
  // addHabitDays(d, 0) round-trips through Date, so an impossible date comes back different.
  if (!isHabitDay(v) || addHabitDays(v, 0) !== v) {
    throw new ValidationError('day must be a date, YYYY-MM-DD.', 'invalid_day');
  }
  if (v > habitDay(now, settings)) throw new ValidationError('day is in the future.', 'invalid_day');
  return v;
}

function validNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError('note must be a string.', 'invalid_note');
  const trimmed = v.trim();
  if (trimmed.length > MOOD_ENERGY_NOTE_MAX_LENGTH) {
    throw new ValidationError(`Notes are at most ${MOOD_ENERGY_NOTE_MAX_LENGTH} characters.`, 'invalid_note');
  }
  return trimmed === '' ? null : trimmed;
}

function validClientId(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 100) {
    throw new ValidationError('clientId is required.', 'invalid_client_id');
  }
  return v.trim();
}

/* ── Tags ───────────────────────────────────── */

export function listTags(db: Database.Database, opts: { includeHidden?: boolean } = {}): MoodEnergyTag[] {
  const where = opts.includeHidden ? '' : 'WHERE hidden_at IS NULL';
  const rows = db.prepare(`SELECT * FROM mood_energy_tags ${where} ORDER BY created_at, id`).all() as TagRow[];
  return rows.map(rowToTag);
}

/** Resolve a (validated) name to a visible tag's id, creating or un-hiding it as needed. */
function ensureTag(db: Database.Database, name: string, now: number): number {
  const existing = db.prepare(`SELECT * FROM mood_energy_tags WHERE name = ?`).get(name) as TagRow | undefined;
  if (existing) {
    if (existing.hidden_at !== null) {
      db.prepare(`UPDATE mood_energy_tags SET hidden_at = NULL WHERE id = ?`).run(existing.id);
    }
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO mood_energy_tags (name, created_at) VALUES (?, ?)`).run(name, now).lastInsertRowid);
}

export function createTag(db: Database.Database, rawName: unknown, now = Date.now()): MoodEnergyTag {
  const id = ensureTag(db, validTagName(rawName), now);
  return rowToTag(db.prepare(`SELECT * FROM mood_energy_tags WHERE id = ?`).get(id) as TagRow);
}

/** Hide a tag from the cloud. Entries that used it keep it. Returns false if no such tag. */
export function hideTag(db: Database.Database, id: number, now = Date.now()): boolean {
  return (
    db.prepare(`UPDATE mood_energy_tags SET hidden_at = COALESCE(hidden_at, ?) WHERE id = ?`).run(now, id).changes > 0
  );
}

/* ── Entries ────────────────────────────────── */

function setEntryTags(db: Database.Database, entryId: number, names: string[], now: number): void {
  db.prepare(`DELETE FROM mood_energy_entry_tags WHERE entry_id = ?`).run(entryId);
  const link = db.prepare(`INSERT INTO mood_energy_entry_tags (entry_id, tag_id) VALUES (?, ?)`);
  for (const name of names) link.run(entryId, ensureTag(db, name, now));
}

export function getEntry(db: Database.Database, id: number): MoodEnergyEntry | null {
  const row = db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function getEntryByDay(db: Database.Database, day: string): MoodEnergyEntry | null {
  const row = db.prepare(`${ENTRY_SELECT} WHERE e.day = ?`).get(day) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export const LIST_DEFAULT_LIMIT = 60;
export const LIST_MAX_LIMIT = 5000;

/**
 * Newest day first. `since` / `until` are habit days, inclusive. With a range the default limit is
 * the maximum (≈14 years of days), since a range is already the bound the caller wants.
 */
export function listEntries(
  db: Database.Database,
  opts: { since?: string; until?: string; limit?: number } = {},
): MoodEnergyEntry[] {
  const ranged = opts.since !== undefined || opts.until !== undefined;
  const fallback = ranged ? LIST_MAX_LIMIT : LIST_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? fallback), 1), LIST_MAX_LIMIT);
  const rows = db
    .prepare(`${ENTRY_SELECT} WHERE e.day >= ? AND e.day <= ? ORDER BY e.day DESC LIMIT ?`)
    .all(opts.since ?? '0000-00-00', opts.until ?? '9999-99-99', limit) as EntryRow[];
  return rows.map(rowToEntry);
}

/**
 * Upsert the entry for a day. Idempotent on `clientId`: a replay returns the current row with
 * `created: false` and changes nothing. Otherwise `created` says whether the day had no entry yet.
 */
export function saveEntry(
  db: Database.Database,
  input: Partial<Record<keyof SaveMoodEnergyEntryInput, unknown>>,
  now = Date.now(),
): { entry: MoodEnergyEntry; created: boolean } {
  const clientId = validClientId(input.clientId);
  const seen = db.prepare(`SELECT entry_id FROM mood_energy_client_ids WHERE client_id = ?`).get(clientId) as
    | { entry_id: number }
    | undefined;
  if (seen) return { entry: getEntry(db, seen.entry_id) as MoodEnergyEntry, created: false };

  const settings = getSettings(db);
  const recordedAt = validRecordedAt(input.recordedAt, now);
  const day = input.day === undefined || input.day === null ? habitDay(recordedAt, settings) : validDay(input.day, now, settings);
  const mood = validValue(input.mood, 'mood');
  const energy = validValue(input.energy, 'energy');
  const tags = validTagList(input.tags ?? []);
  const note = validNote(input.note);

  return db.transaction(() => {
    const existing = db.prepare(`SELECT id FROM mood_energy_entries WHERE day = ?`).get(day) as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      db.prepare(
        `UPDATE mood_energy_entries SET recorded_at = ?, mood = ?, energy = ?, note = ?, updated_at = ? WHERE id = ?`,
      ).run(recordedAt, mood, energy, note, now, id);
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO mood_energy_entries (day, recorded_at, mood, energy, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(day, recordedAt, mood, energy, note, now, now).lastInsertRowid,
      );
    }
    setEntryTags(db, id, tags, now);
    db.prepare(`INSERT INTO mood_energy_client_ids (client_id, entry_id, created_at) VALUES (?, ?, ?)`).run(
      clientId,
      id,
      now,
    );
    return { entry: getEntry(db, id) as MoodEnergyEntry, created: !existing };
  })();
}

/** Returns null if there is no such entry. Only the fields present change; `recordedAt` becomes now. */
export function updateEntry(
  db: Database.Database,
  id: number,
  input: Partial<Record<keyof UpdateMoodEnergyEntryInput, unknown>>,
  now = Date.now(),
): MoodEnergyEntry | null {
  if (!getEntry(db, id)) return null;
  const sets: string[] = ['recorded_at = ?', 'updated_at = ?'];
  const params: (string | number | null)[] = [now, now];
  if (input.mood !== undefined) {
    sets.push('mood = ?');
    params.push(validValue(input.mood, 'mood'));
  }
  if (input.energy !== undefined) {
    sets.push('energy = ?');
    params.push(validValue(input.energy, 'energy'));
  }
  if (input.note !== undefined) {
    sets.push('note = ?');
    params.push(validNote(input.note));
  }
  const tags = input.tags === undefined ? undefined : validTagList(input.tags);

  db.transaction(() => {
    db.prepare(`UPDATE mood_energy_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    if (tags !== undefined) setEntryTags(db, id, tags, now);
  })();
  return getEntry(db, id);
}

export function deleteEntry(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM mood_energy_entries WHERE id = ?`).run(id).changes > 0;
}
