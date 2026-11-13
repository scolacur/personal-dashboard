import type Database from 'better-sqlite3';
import {
  isValidIntensity,
  normalizeTagName,
  TINNITUS_FUTURE_TOLERANCE_MS,
  TINNITUS_MAX,
  TINNITUS_MIN,
  TINNITUS_NOTES_MAX_LENGTH,
  TINNITUS_TAG_MAX_LENGTH,
  type CreateTinnitusEntryInput,
  type TinnitusEntry,
  type TinnitusTag,
  type UpdateTinnitusEntryInput,
} from '@dashboard/shared';

/**
 * Tinnitus Tracker store. All SQL lives here; route handlers have none (PROJECT.md §5).
 *
 * Two invariants this module owns:
 *  - **Tags are referenced by name on the wire and by id in the DB.** An entry naming an unknown
 *    tag creates it, and naming a hidden one un-hides it. That is what lets a phone that was
 *    offline when a custom tag was added still sync the entry that uses it.
 *  - **`client_id` makes create idempotent.** The offline queue replays an entry whose response
 *    was lost; the replay returns the existing row instead of logging it twice.
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
  client_id: string;
  recorded_at: number;
  intensity: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
  tags_json: string;
}

function rowToTag(r: TagRow): TinnitusTag {
  return { id: r.id, name: r.name, hiddenAt: r.hidden_at, createdAt: r.created_at };
}

function rowToEntry(r: EntryRow): TinnitusEntry {
  const tags = (JSON.parse(r.tags_json) as (string | null)[]).filter((t): t is string => t !== null);
  return {
    id: r.id,
    clientId: r.client_id,
    recordedAt: r.recorded_at,
    intensity: r.intensity,
    tags: tags.sort(),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ENTRY_SELECT = `
  SELECT e.*,
    (SELECT json_group_array(t.name)
       FROM tinnitus_tracker_entry_tags et
       JOIN tinnitus_tracker_tags t ON t.id = et.tag_id
      WHERE et.entry_id = e.id) AS tags_json
  FROM tinnitus_tracker_entries e`;

/* ── Validation ─────────────────────────────── */

function validTagName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Tag names must be strings.', 'invalid_tag');
  const name = normalizeTagName(raw);
  if (name === '') throw new ValidationError('Tag name is empty.', 'invalid_tag');
  if (name.length > TINNITUS_TAG_MAX_LENGTH) {
    throw new ValidationError(`Tag names are at most ${TINNITUS_TAG_MAX_LENGTH} characters.`, 'invalid_tag');
  }
  return name;
}

function validTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ValidationError('tags must be an array of names.', 'invalid_tags');
  return [...new Set(raw.map(validTagName))];
}

function validIntensity(v: unknown): number {
  if (!isValidIntensity(v)) {
    throw new ValidationError(
      `intensity must be a whole number from ${TINNITUS_MIN} to ${TINNITUS_MAX}.`,
      'invalid_intensity',
    );
  }
  return v;
}

function validRecordedAt(v: unknown, now: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ValidationError('recordedAt must be a unix-ms timestamp.', 'invalid_recorded_at');
  }
  if (v > now + TINNITUS_FUTURE_TOLERANCE_MS) {
    throw new ValidationError('recordedAt is in the future.', 'invalid_recorded_at');
  }
  return v;
}

function validNotes(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError('notes must be a string.', 'invalid_notes');
  const trimmed = v.trim();
  if (trimmed.length > TINNITUS_NOTES_MAX_LENGTH) {
    throw new ValidationError(`Notes are at most ${TINNITUS_NOTES_MAX_LENGTH} characters.`, 'invalid_notes');
  }
  return trimmed === '' ? null : trimmed;
}

/* ── Tags ───────────────────────────────────── */

export function listTags(db: Database.Database, opts: { includeHidden?: boolean } = {}): TinnitusTag[] {
  const where = opts.includeHidden ? '' : 'WHERE hidden_at IS NULL';
  const rows = db
    .prepare(`SELECT * FROM tinnitus_tracker_tags ${where} ORDER BY created_at, id`)
    .all() as TagRow[];
  return rows.map(rowToTag);
}

/** Resolve a (validated) name to a visible tag's id, creating or un-hiding it as needed. */
function ensureTag(db: Database.Database, name: string, now: number): number {
  const existing = db.prepare(`SELECT * FROM tinnitus_tracker_tags WHERE name = ?`).get(name) as TagRow | undefined;
  if (existing) {
    if (existing.hidden_at !== null) {
      db.prepare(`UPDATE tinnitus_tracker_tags SET hidden_at = NULL WHERE id = ?`).run(existing.id);
    }
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO tinnitus_tracker_tags (name, created_at) VALUES (?, ?)`).run(name, now).lastInsertRowid);
}

export function createTag(db: Database.Database, rawName: unknown, now = Date.now()): TinnitusTag {
  const id = ensureTag(db, validTagName(rawName), now);
  return rowToTag(db.prepare(`SELECT * FROM tinnitus_tracker_tags WHERE id = ?`).get(id) as TagRow);
}

/** Hide a tag from the cloud. Entries that used it keep it. Returns false if no such tag. */
export function hideTag(db: Database.Database, id: number, now = Date.now()): boolean {
  // COALESCE keeps the first hide time if it's hidden twice.
  return (
    db.prepare(`UPDATE tinnitus_tracker_tags SET hidden_at = COALESCE(hidden_at, ?) WHERE id = ?`).run(now, id)
      .changes > 0
  );
}

/* ── Entries ────────────────────────────────── */

function setEntryTags(db: Database.Database, entryId: number, names: string[], now: number): void {
  db.prepare(`DELETE FROM tinnitus_tracker_entry_tags WHERE entry_id = ?`).run(entryId);
  const link = db.prepare(`INSERT INTO tinnitus_tracker_entry_tags (entry_id, tag_id) VALUES (?, ?)`);
  for (const name of names) link.run(entryId, ensureTag(db, name, now));
}

export function getEntry(db: Database.Database, id: number): TinnitusEntry | null {
  const row = db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function listEntries(db: Database.Database, opts: { limit?: number } = {}): TinnitusEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = db
    .prepare(`${ENTRY_SELECT} ORDER BY e.recorded_at DESC, e.id DESC LIMIT ?`)
    .all(limit) as EntryRow[];
  return rows.map(rowToEntry);
}

export function createEntry(
  db: Database.Database,
  input: Partial<Record<keyof CreateTinnitusEntryInput, unknown>>,
  now = Date.now(),
): { entry: TinnitusEntry; created: boolean } {
  if (typeof input.clientId !== 'string' || input.clientId.trim() === '' || input.clientId.length > 100) {
    throw new ValidationError('clientId is required.', 'invalid_client_id');
  }
  const clientId = input.clientId.trim();
  const existing = db.prepare(`SELECT id FROM tinnitus_tracker_entries WHERE client_id = ?`).get(clientId) as
    | { id: number }
    | undefined;
  if (existing) return { entry: getEntry(db, existing.id) as TinnitusEntry, created: false };

  const recordedAt = validRecordedAt(input.recordedAt, now);
  const intensity = validIntensity(input.intensity);
  const tags = validTagList(input.tags ?? []);
  const notes = validNotes(input.notes);

  const id = db.transaction(() => {
    const newId = Number(
      db
        .prepare(
          `INSERT INTO tinnitus_tracker_entries (client_id, recorded_at, intensity, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(clientId, recordedAt, intensity, notes, now, now).lastInsertRowid,
    );
    setEntryTags(db, newId, tags, now);
    return newId;
  })();
  return { entry: getEntry(db, id) as TinnitusEntry, created: true };
}

/** Returns null if there is no such entry. Only the fields present in `input` change. */
export function updateEntry(
  db: Database.Database,
  id: number,
  input: Partial<Record<keyof UpdateTinnitusEntryInput, unknown>>,
  now = Date.now(),
): TinnitusEntry | null {
  if (!getEntry(db, id)) return null;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.recordedAt !== undefined) {
    sets.push('recorded_at = ?');
    params.push(validRecordedAt(input.recordedAt, now));
  }
  if (input.intensity !== undefined) {
    sets.push('intensity = ?');
    params.push(validIntensity(input.intensity));
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?');
    params.push(validNotes(input.notes));
  }
  const tags = input.tags === undefined ? undefined : validTagList(input.tags);

  db.transaction(() => {
    sets.push('updated_at = ?');
    params.push(now);
    db.prepare(`UPDATE tinnitus_tracker_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    if (tags !== undefined) setEntryTags(db, id, tags, now);
  })();
  return getEntry(db, id);
}

export function deleteEntry(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM tinnitus_tracker_entries WHERE id = ?`).run(id).changes > 0;
}
