import type Database from 'better-sqlite3';
import {
  isValidRested,
  isValidTagCount,
  normalizeSleepTagName,
  sleepWakeDate,
  SLEEP_FUTURE_TOLERANCE_MS,
  SLEEP_MAX_DURATION_MS,
  SLEEP_NOTES_MAX_LENGTH,
  SLEEP_RESTED_MAX,
  SLEEP_RESTED_MIN,
  SLEEP_TAG_COUNT_MAX,
  SLEEP_TAG_COUNT_MIN,
  SLEEP_TAG_MAX_LENGTH,
  type CreateSleepEntryInput,
  type SleepEntry,
  type SleepTag,
  type SleepTagCount,
  type UpdateSleepEntryInput,
} from '@dashboard/shared';

/**
 * Sleep Journal store. All SQL lives here; route handlers have none (PROJECT.md §5).
 *
 * Invariants this module owns:
 *  - **One night per wake date.** The wake date is derived from `wakeAt` here, never taken from the
 *    client. Creating a night whose wake date is taken updates that night instead (an upsert).
 *  - **Every client id that wrote a night is remembered**, so the outbox can replay any create
 *    whose response was lost without re-applying it over a later edit.
 *  - **Tags are referenced by name on the wire and by id in the DB.** An unknown name is created
 *    and a hidden one un-hidden, so a custom tag added offline still syncs.
 */

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The request was well-formed but collides with another night (an edit onto a taken wake date). */
export class ConflictError extends ValidationError {}

interface TagRow {
  id: number;
  name: string;
  hidden_at: number | null;
  created_at: number;
}

interface EntryRow {
  id: number;
  client_id: string;
  wake_date: string;
  sleep_at: number;
  wake_at: number;
  rested: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
  tags_json: string;
}

function rowToTag(r: TagRow): SleepTag {
  return { id: r.id, name: r.name, hiddenAt: r.hidden_at, createdAt: r.created_at };
}

function rowToEntry(r: EntryRow): SleepEntry {
  const tags = (JSON.parse(r.tags_json) as (SleepTagCount | null)[]).filter((t): t is SleepTagCount => t !== null);
  return {
    id: r.id,
    clientId: r.client_id,
    wakeDate: r.wake_date,
    sleepAt: r.sleep_at,
    wakeAt: r.wake_at,
    rested: r.rested,
    tags: tags.sort((a, b) => a.name.localeCompare(b.name)),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ENTRY_SELECT = `
  SELECT e.*,
    (SELECT json_group_array(json_object('name', t.name, 'count', et.count))
       FROM sleep_journal_entry_tags et
       JOIN sleep_journal_tags t ON t.id = et.tag_id
      WHERE et.entry_id = e.id) AS tags_json
  FROM sleep_journal_entries e`;

/* ── Validation ─────────────────────────────── */

function validTagName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Tag names must be strings.', 'invalid_tag');
  const name = normalizeSleepTagName(raw);
  if (name === '') throw new ValidationError('Tag name is empty.', 'invalid_tag');
  if (name.length > SLEEP_TAG_MAX_LENGTH) {
    throw new ValidationError(`Tag names are at most ${SLEEP_TAG_MAX_LENGTH} characters.`, 'invalid_tag');
  }
  return name;
}

/** `{name, count}[]`, deduped case-insensitively (the last count for a name wins). */
function validTagList(raw: unknown): SleepTagCount[] {
  if (!Array.isArray(raw)) throw new ValidationError('tags must be an array of {name, count}.', 'invalid_tags');
  const byKey = new Map<string, SleepTagCount>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new ValidationError('tags must be an array of {name, count}.', 'invalid_tags');
    }
    const { name: rawName, count } = item as { name?: unknown; count?: unknown };
    const name = validTagName(rawName);
    if (!isValidTagCount(count)) {
      throw new ValidationError(
        `Tag counts must be whole numbers from ${SLEEP_TAG_COUNT_MIN} to ${SLEEP_TAG_COUNT_MAX}.`,
        'invalid_count',
      );
    }
    byKey.set(name.toLowerCase(), { name, count });
  }
  return [...byKey.values()];
}

function validRested(v: unknown): number {
  if (!isValidRested(v)) {
    throw new ValidationError(
      `rested must be a whole number from ${SLEEP_RESTED_MIN} to ${SLEEP_RESTED_MAX}.`,
      'invalid_rested',
    );
  }
  return v;
}

function validInstant(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ValidationError(`${field} must be a unix-ms timestamp.`, `invalid_${field === 'sleepAt' ? 'sleep_at' : 'wake_at'}`);
  }
  return v;
}

/** The pair together: in order, no longer than a day, and not woken in the future. */
function validNight(sleepAt: number, wakeAt: number, now: number): void {
  if (sleepAt >= wakeAt) throw new ValidationError('Sleep time must be before wake time.', 'invalid_times');
  if (wakeAt - sleepAt > SLEEP_MAX_DURATION_MS) {
    throw new ValidationError('A night is at most 24 hours.', 'invalid_duration');
  }
  if (wakeAt > now + SLEEP_FUTURE_TOLERANCE_MS) {
    throw new ValidationError('Wake time is in the future.', 'invalid_wake_at');
  }
}

function validNotes(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError('notes must be a string.', 'invalid_notes');
  const trimmed = v.trim();
  if (trimmed.length > SLEEP_NOTES_MAX_LENGTH) {
    throw new ValidationError(`Notes are at most ${SLEEP_NOTES_MAX_LENGTH} characters.`, 'invalid_notes');
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

export function listTags(db: Database.Database, opts: { includeHidden?: boolean } = {}): SleepTag[] {
  const where = opts.includeHidden ? '' : 'WHERE hidden_at IS NULL';
  const rows = db.prepare(`SELECT * FROM sleep_journal_tags ${where} ORDER BY created_at, id`).all() as TagRow[];
  return rows.map(rowToTag);
}

/** Resolve a (validated) name to a visible tag's id, creating or un-hiding it as needed. */
function ensureTag(db: Database.Database, name: string, now: number): number {
  const existing = db.prepare(`SELECT * FROM sleep_journal_tags WHERE name = ?`).get(name) as TagRow | undefined;
  if (existing) {
    if (existing.hidden_at !== null) {
      db.prepare(`UPDATE sleep_journal_tags SET hidden_at = NULL WHERE id = ?`).run(existing.id);
    }
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO sleep_journal_tags (name, created_at) VALUES (?, ?)`).run(name, now).lastInsertRowid);
}

export function createTag(db: Database.Database, rawName: unknown, now = Date.now()): SleepTag {
  const id = ensureTag(db, validTagName(rawName), now);
  return rowToTag(db.prepare(`SELECT * FROM sleep_journal_tags WHERE id = ?`).get(id) as TagRow);
}

/** Hide a tag from the cloud. Nights that used it keep it. Returns false if no such tag. */
export function hideTag(db: Database.Database, id: number, now = Date.now()): boolean {
  return (
    db.prepare(`UPDATE sleep_journal_tags SET hidden_at = COALESCE(hidden_at, ?) WHERE id = ?`).run(now, id).changes > 0
  );
}

/* ── Entries ────────────────────────────────── */

function setEntryTags(db: Database.Database, entryId: number, tags: SleepTagCount[], now: number): void {
  db.prepare(`DELETE FROM sleep_journal_entry_tags WHERE entry_id = ?`).run(entryId);
  const link = db.prepare(`INSERT INTO sleep_journal_entry_tags (entry_id, tag_id, count) VALUES (?, ?, ?)`);
  for (const t of tags) link.run(entryId, ensureTag(db, t.name, now), t.count);
}

export function getEntry(db: Database.Database, id: number): SleepEntry | null {
  const row = db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function getEntryByWakeDate(db: Database.Database, wakeDate: string): SleepEntry | null {
  const row = db.prepare(`${ENTRY_SELECT} WHERE e.wake_date = ?`).get(wakeDate) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Newest wake date first. `since` (a wake date, inclusive) serves the Trends range and the
 * History calendar; with it the cap rises to 10,000 nights, which is decades.
 */
export function listEntries(db: Database.Database, opts: { limit?: number; since?: string } = {}): SleepEntry[] {
  const max = opts.since === undefined ? 500 : 10_000;
  const limit = Math.min(Math.max(opts.limit ?? (opts.since === undefined ? 50 : max), 1), max);
  const rows = db
    .prepare(`${ENTRY_SELECT} WHERE e.wake_date >= ? ORDER BY e.wake_date DESC LIMIT ?`)
    .all(opts.since ?? '', limit) as EntryRow[];
  return rows.map(rowToEntry);
}

/**
 * Create a night, or update the night already on that wake date. `created` is true only when a new
 * row was inserted. A replayed client id returns the night it wrote, unchanged.
 */
export function createEntry(
  db: Database.Database,
  input: Partial<Record<keyof CreateSleepEntryInput, unknown>>,
  now = Date.now(),
): { entry: SleepEntry; created: boolean } {
  const clientId = validClientId(input.clientId);
  const seen = db.prepare(`SELECT entry_id FROM sleep_journal_entry_clients WHERE client_id = ?`).get(clientId) as
    | { entry_id: number }
    | undefined;
  if (seen) return { entry: getEntry(db, seen.entry_id) as SleepEntry, created: false };

  const sleepAt = validInstant(input.sleepAt, 'sleepAt');
  const wakeAt = validInstant(input.wakeAt, 'wakeAt');
  validNight(sleepAt, wakeAt, now);
  const rested = validRested(input.rested);
  const tags = validTagList(input.tags ?? []);
  const notes = validNotes(input.notes);
  const wakeDate = sleepWakeDate(wakeAt);

  return db.transaction(() => {
    const existing = db.prepare(`SELECT id FROM sleep_journal_entries WHERE wake_date = ?`).get(wakeDate) as
      | { id: number }
      | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      db.prepare(
        `UPDATE sleep_journal_entries SET sleep_at = ?, wake_at = ?, rested = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(sleepAt, wakeAt, rested, notes, now, id);
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO sleep_journal_entries
               (client_id, wake_date, sleep_at, wake_at, rested, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(clientId, wakeDate, sleepAt, wakeAt, rested, notes, now, now).lastInsertRowid,
      );
    }
    db.prepare(`INSERT INTO sleep_journal_entry_clients (client_id, entry_id) VALUES (?, ?)`).run(clientId, id);
    setEntryTags(db, id, tags, now);
    return { entry: getEntry(db, id) as SleepEntry, created: !existing };
  })();
}

/**
 * Returns null if there is no such night. Only the fields present in `input` change; `tags`
 * replaces the whole set. Moving a night onto a wake date another night holds is a conflict.
 */
export function updateEntry(
  db: Database.Database,
  id: number,
  input: Partial<Record<keyof UpdateSleepEntryInput, unknown>>,
  now = Date.now(),
): SleepEntry | null {
  const current = getEntry(db, id);
  if (!current) return null;

  const sleepAt = input.sleepAt === undefined ? current.sleepAt : validInstant(input.sleepAt, 'sleepAt');
  const wakeAt = input.wakeAt === undefined ? current.wakeAt : validInstant(input.wakeAt, 'wakeAt');
  validNight(sleepAt, wakeAt, now);
  const rested = input.rested === undefined ? current.rested : validRested(input.rested);
  const notes = input.notes === undefined ? current.notes : validNotes(input.notes);
  const tags = input.tags === undefined ? undefined : validTagList(input.tags);
  const wakeDate = sleepWakeDate(wakeAt);

  if (wakeDate !== current.wakeDate) {
    const other = getEntryByWakeDate(db, wakeDate);
    if (other) throw new ConflictError(`The night of ${wakeDate} already has an entry.`, 'wake_date_taken');
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE sleep_journal_entries
          SET wake_date = ?, sleep_at = ?, wake_at = ?, rested = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
    ).run(wakeDate, sleepAt, wakeAt, rested, notes, now, id);
    if (tags !== undefined) setEntryTags(db, id, tags, now);
  })();
  return getEntry(db, id);
}

export function deleteEntry(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM sleep_journal_entries WHERE id = ?`).run(id).changes > 0;
}
