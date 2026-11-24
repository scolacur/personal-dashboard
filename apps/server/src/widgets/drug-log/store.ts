import type Database from 'better-sqlite3';
import {
  DRUG_LOG_FUTURE_TOLERANCE_MS,
  DRUG_LOG_LABEL_MAX_LENGTH,
  normalizeDrugLabel,
  normalizeHexColor,
  type CreateDrugLogDrugInput,
  type CreateDrugLogEventInput,
  type DrugLogDrug,
  type DrugLogEvent,
  type UpdateDrugLogDrugInput,
  type UpdateDrugLogEventInput,
} from '@dashboard/shared';

/**
 * Drug Log store. All SQL lives here; route handlers have none (PROJECT.md §5). PD-975 (Drug log
 * widget).
 *
 * Invariants this module owns:
 *  - **`client_id` makes event creation idempotent.** The offline outbox replays a tap whose
 *    response was lost; the replay returns the existing row rather than logging it twice.
 *  - **Deleting a drug deletes its events** (FK cascade, and an explicit delete as a backstop in
 *    case a connection was opened without `foreign_keys = ON`). Archiving keeps them.
 */

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface DrugRow {
  id: number;
  label: string;
  color: string;
  sort_order: number;
  archived_at: number | null;
  created_at: number;
  event_count: number;
}

interface EventRow {
  id: number;
  client_id: string;
  drug_id: number;
  recorded_at: number;
  created_at: number;
  updated_at: number;
}

function rowToDrug(r: DrugRow): DrugLogDrug {
  return {
    id: r.id,
    label: r.label,
    color: r.color,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    eventCount: r.event_count,
  };
}

function rowToEvent(r: EventRow): DrugLogEvent {
  return {
    id: r.id,
    clientId: r.client_id,
    drugId: r.drug_id,
    recordedAt: r.recorded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const DRUG_SELECT = `
  SELECT d.*, (SELECT COUNT(*) FROM drug_log_events e WHERE e.drug_id = d.id) AS event_count
  FROM drug_log_drugs d`;

/* ── Validation ─────────────────────────────── */

function validLabel(raw: unknown): string {
  if (typeof raw !== 'string')
    throw new ValidationError('label must be a string.', 'invalid_label');
  const label = normalizeDrugLabel(raw);
  if (label === '') throw new ValidationError('Label is empty.', 'invalid_label');
  if ([...label].length > DRUG_LOG_LABEL_MAX_LENGTH) {
    throw new ValidationError(
      `Labels are at most ${DRUG_LOG_LABEL_MAX_LENGTH} characters.`,
      'invalid_label',
    );
  }
  return label;
}

function validColor(raw: unknown): string {
  const color = normalizeHexColor(raw);
  if (color === null)
    throw new ValidationError('color must be a hex colour like #2e9e5b.', 'invalid_color');
  return color;
}

function validSortOrder(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new ValidationError('sortOrder must be an integer.', 'invalid_sort_order');
  }
  return raw;
}

function validRecordedAt(v: unknown, now: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ValidationError('recordedAt must be a unix-ms timestamp.', 'invalid_recorded_at');
  }
  if (v > now + DRUG_LOG_FUTURE_TOLERANCE_MS) {
    throw new ValidationError('recordedAt is in the future.', 'invalid_recorded_at');
  }
  return v;
}

function validDrugId(db: Database.Database, v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ValidationError('drugId must be a drug id.', 'invalid_drug');
  }
  if (!db.prepare(`SELECT 1 FROM drug_log_drugs WHERE id = ?`).get(v)) {
    throw new ValidationError('No such drug.', 'unknown_drug');
  }
  return v;
}

/* ── Drugs ──────────────────────────────────── */

export function getDrug(db: Database.Database, id: number): DrugLogDrug | null {
  const row = db.prepare(`${DRUG_SELECT} WHERE d.id = ?`).get(id) as DrugRow | undefined;
  return row ? rowToDrug(row) : null;
}

/** Every drug, archived included, in grid order. */
export function listDrugs(db: Database.Database): DrugLogDrug[] {
  return (db.prepare(`${DRUG_SELECT} ORDER BY d.sort_order, d.id`).all() as DrugRow[]).map(
    rowToDrug,
  );
}

/** A new drug goes to the end of the grid. */
export function createDrug(
  db: Database.Database,
  input: Partial<Record<keyof CreateDrugLogDrugInput, unknown>>,
  now = Date.now(),
): DrugLogDrug {
  const label = validLabel(input.label);
  const color = validColor(input.color);
  const { next } = db
    .prepare(`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM drug_log_drugs`)
    .get() as {
    next: number;
  };
  const id = Number(
    db
      .prepare(
        `INSERT INTO drug_log_drugs (label, color, sort_order, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(label, color, next, now).lastInsertRowid,
  );
  return getDrug(db, id) as DrugLogDrug;
}

/** Null if there is no such drug. Only the fields present in `input` change. */
export function updateDrug(
  db: Database.Database,
  id: number,
  input: Partial<Record<keyof UpdateDrugLogDrugInput, unknown>>,
  now = Date.now(),
): DrugLogDrug | null {
  const existing = getDrug(db, id);
  if (!existing) return null;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.label !== undefined) {
    sets.push('label = ?');
    params.push(validLabel(input.label));
  }
  if (input.color !== undefined) {
    sets.push('color = ?');
    params.push(validColor(input.color));
  }
  if (input.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    params.push(validSortOrder(input.sortOrder));
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') {
      throw new ValidationError('archived must be a boolean.', 'invalid_archived');
    }
    sets.push('archived_at = ?');
    // Re-archiving keeps the first archive time.
    params.push(input.archived ? (existing.archivedAt ?? now) : null);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE drug_log_drugs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return getDrug(db, id);
}

/** Hard delete: the drug and every event logged against it. False if there was no such drug. */
export function deleteDrug(db: Database.Database, id: number): boolean {
  return db.transaction(() => {
    db.prepare(`DELETE FROM drug_log_events WHERE drug_id = ?`).run(id);
    return db.prepare(`DELETE FROM drug_log_drugs WHERE id = ?`).run(id).changes > 0;
  })();
}

/* ── Events ─────────────────────────────────── */

export const EVENTS_DEFAULT_LIMIT = 500;
export const EVENTS_MAX_LIMIT = 10_000;

export interface ListEventsOptions {
  /** Unix ms, inclusive. */
  since?: number;
  /** Unix ms, exclusive. */
  until?: number;
  drugId?: number;
  limit?: number;
}

export function getEvent(db: Database.Database, id: number): DrugLogEvent | null {
  const row = db.prepare(`SELECT * FROM drug_log_events WHERE id = ?`).get(id) as
    EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/** Newest first by `recordedAt`. Capped at {@link EVENTS_MAX_LIMIT} — years of taps. */
export function listEvents(db: Database.Database, opts: ListEventsOptions = {}): DrugLogEvent[] {
  const where: string[] = [];
  const params: number[] = [];
  if (opts.since !== undefined) {
    where.push('recorded_at >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push('recorded_at < ?');
    params.push(opts.until);
  }
  if (opts.drugId !== undefined) {
    where.push('drug_id = ?');
    params.push(opts.drugId);
  }
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? EVENTS_DEFAULT_LIMIT), 1),
    EVENTS_MAX_LIMIT,
  );
  const sql = `SELECT * FROM drug_log_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY recorded_at DESC, id DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, limit) as EventRow[]).map(rowToEvent);
}

export function createEvent(
  db: Database.Database,
  input: Partial<Record<keyof CreateDrugLogEventInput, unknown>>,
  now = Date.now(),
): { event: DrugLogEvent; created: boolean } {
  if (
    typeof input.clientId !== 'string' ||
    input.clientId.trim() === '' ||
    input.clientId.length > 100
  ) {
    throw new ValidationError('clientId is required.', 'invalid_client_id');
  }
  const clientId = input.clientId.trim();
  const existing = db.prepare(`SELECT * FROM drug_log_events WHERE client_id = ?`).get(clientId) as
    EventRow | undefined;
  if (existing) return { event: rowToEvent(existing), created: false };

  const recordedAt = validRecordedAt(input.recordedAt, now);
  const drugId = validDrugId(db, input.drugId);
  const id = Number(
    db
      .prepare(
        `INSERT INTO drug_log_events (client_id, drug_id, recorded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(clientId, drugId, recordedAt, now, now).lastInsertRowid,
  );
  return { event: getEvent(db, id) as DrugLogEvent, created: true };
}

/** Null if there is no such event. Only the fields present in `input` change. */
export function updateEvent(
  db: Database.Database,
  id: number,
  input: Partial<Record<keyof UpdateDrugLogEventInput, unknown>>,
  now = Date.now(),
): DrugLogEvent | null {
  if (!getEvent(db, id)) return null;
  const sets: string[] = [];
  const params: number[] = [];
  if (input.recordedAt !== undefined) {
    sets.push('recorded_at = ?');
    params.push(validRecordedAt(input.recordedAt, now));
  }
  if (input.drugId !== undefined) {
    sets.push('drug_id = ?');
    params.push(validDrugId(db, input.drugId));
  }
  sets.push('updated_at = ?');
  params.push(now);
  db.prepare(`UPDATE drug_log_events SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return getEvent(db, id);
}

export function deleteEvent(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM drug_log_events WHERE id = ?`).run(id).changes > 0;
}
