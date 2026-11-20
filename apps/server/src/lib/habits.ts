import type Database from 'better-sqlite3';
import {
  DEFAULT_DAY_BOUNDARY_MINUTES,
  DEFAULT_HABIT_TIMEZONE,
  HABIT_CHOICE_LABEL_MAX_LENGTH,
  HABIT_NAME_MAX_LENGTH,
  habitDay,
  isDue,
  isHabitDay,
  isValidDayBoundaryMinutes,
  isValidDaysMask,
  isValidMetricValueFormat,
  isValidPerWeekN,
  isValidTimezone,
  nodeDone,
  nodeDue,
  nodeProgress,
  parseChoiceValue,
  perWeekProgress,
  projectHabitDay,
  scheduleForDay,
  setStreak,
  streak,
  type HabitChoiceOption,
  type HabitCompletion,
  type HabitHistoryNode,
  type HabitItemView,
  type HabitMetricTodayRow,
  type HabitMetricType,
  type HabitMetricValue,
  type HabitSchedule,
  type HabitScheduleKind,
  type HabitSettings,
  type HabitTodayRow,
  type HabitTodayView,
} from '@dashboard/shared';

/**
 * Habit Tracker store (PD-721, D-092).
 *
 * A shared **domain** store in `apps/server/src/lib/`, beside the job-run store (PD-442) and the
 * shell-layout store — not a widget's tables (D-092). The Habit Tracker widget owns only its routes
 * and UI; habit history has one home here so the 2025 import (PD-694) and the correlations (PD-696)
 * read it through this accessor rather than through a widget folder. The access layer is
 * middleware, not a firewall (D-092 §7).
 *
 * Schema is bootstrapped inline, the way `lib/job-runs.ts` does it, not via a widget `schema.ts`.
 *
 * This tracer slice builds only the three tables it needs — `habit_items`, `habit_completions` and
 * `habit_settings` — but shapes `habit_items` with `parent_id`, `kind` and `metric_type` so later
 * slices (schedules PD-722, sets PD-723, metrics PD-724) add columns/tables without migrating it.
 */

export class HabitValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface HabitItemRow {
  id: number;
  parent_id: number | null;
  kind: string;
  metric_type: string | null;
  name: string;
  sort_order: number;
  archived_at: number | null;
  created_at: number;
  completion_count: number;
}

interface HabitCompletionRow {
  item_id: number;
  day: string;
  completed_at: number;
}

interface HabitSettingsRow {
  day_boundary_minutes: number;
  timezone: string;
}

interface HabitScheduleRow {
  id: number;
  item_id: number;
  effective_from_day: string;
  kind: string;
  days_mask: number | null;
  per_week_n: number | null;
}

interface HabitMetricValueRow {
  item_id: number;
  day: string;
  value: string;
  updated_at: number;
}

interface HabitChoiceOptionRow {
  id: number;
  item_id: number;
  label: string;
  sort_order: number;
  archived_at: number | null;
}

function rowToMetricValue(r: HabitMetricValueRow): HabitMetricValue {
  return { itemId: r.item_id, day: r.day, value: r.value, updatedAt: r.updated_at };
}

function rowToChoiceOption(r: HabitChoiceOptionRow): HabitChoiceOption {
  return { id: r.id, itemId: r.item_id, label: r.label, sortOrder: r.sort_order, archivedAt: r.archived_at };
}

function rowToSchedule(r: HabitScheduleRow): HabitSchedule {
  return {
    id: r.id,
    itemId: r.item_id,
    effectiveFromDay: r.effective_from_day,
    kind: r.kind as HabitScheduleKind,
    daysMask: r.days_mask,
    perWeekN: r.per_week_n,
  };
}

function rowToItem(r: HabitItemRow): HabitItemView {
  return {
    id: r.id,
    parentId: r.parent_id,
    kind: r.kind as HabitItemView['kind'],
    metricType: r.metric_type as HabitItemView['metricType'],
    name: r.name,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    completionCount: r.completion_count,
  };
}

function rowToCompletion(r: HabitCompletionRow): HabitCompletion {
  return { itemId: r.item_id, day: r.day, completedAt: r.completed_at };
}

const SETTINGS_ID = 1;

export function bootstrapHabitsSchema(db: Database.Database): void {
  // The schema below is a JS template literal: never use a backtick inside it, including in SQL
  // comments. Quoting a word in backticks there ends the string early and breaks the build.
  db.exec(`
    CREATE TABLE IF NOT EXISTS habit_items (
      id          INTEGER PRIMARY KEY,
      parent_id   INTEGER REFERENCES habit_items(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL DEFAULT 'habit' CHECK (kind IN ('habit', 'metric')),
      metric_type TEXT    CHECK (metric_type IN ('time', 'number', 'choice')),
      name        TEXT    NOT NULL,
      sort_order  INTEGER NOT NULL,
      archived_at INTEGER,
      created_at  INTEGER NOT NULL
    );

    /* Today and the manage list read items by sibling order. */
    CREATE INDEX IF NOT EXISTS idx_habit_items_order
      ON habit_items (parent_id, sort_order);

    CREATE TABLE IF NOT EXISTS habit_completions (
      item_id      INTEGER NOT NULL REFERENCES habit_items(id) ON DELETE CASCADE,
      day          TEXT    NOT NULL,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, day)
    );

    /* Range reads for Today and (later) the Log pull completions by day. */
    CREATE INDEX IF NOT EXISTS idx_habit_completions_day
      ON habit_completions (day);

    /* Effective-dated schedules (PD-722, D-095): the row in force on a day is the latest one whose
       effective_from_day <= day. A schedule change inserts/replaces the row for today and never
       touches a past row, so history is judged by the schedule that applied then. An item with no
       row is treated as daily. UNIQUE(item_id, effective_from_day) makes a same-day re-edit an
       upsert rather than a pile of rows. */
    CREATE TABLE IF NOT EXISTS habit_schedules (
      id                 INTEGER PRIMARY KEY,
      item_id            INTEGER NOT NULL REFERENCES habit_items(id) ON DELETE CASCADE,
      effective_from_day TEXT    NOT NULL,
      kind               TEXT    NOT NULL CHECK (kind IN ('days_of_week', 'per_week')),
      days_mask          INTEGER,
      per_week_n         INTEGER,
      UNIQUE (item_id, effective_from_day)
    );

    CREATE INDEX IF NOT EXISTS idx_habit_schedules_item
      ON habit_schedules (item_id, effective_from_day);

    /* Typed daily metric values (PD-724). One row per (metric, habit day); a missing row is
       not-logged, distinct from a logged '0'. The value is always stored as TEXT: 'HH:MM' for a
       time metric, a decimal string for a number metric, or a JSON array of option ids for a choice
       metric. Clearing a value deletes the row. */
    CREATE TABLE IF NOT EXISTS habit_metric_values (
      item_id    INTEGER NOT NULL REFERENCES habit_items(id) ON DELETE CASCADE,
      day        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, day)
    );

    /* Range reads for Today and (later) the Log pull metric values by day. */
    CREATE INDEX IF NOT EXISTS idx_habit_metric_values_day
      ON habit_metric_values (day);

    /* The options a choice metric offers (PD-724). User-edited and archivable: archiving keeps an
       option in history while removing it from new picks; a stored value references option ids. */
    CREATE TABLE IF NOT EXISTS habit_choice_options (
      id          INTEGER PRIMARY KEY,
      item_id     INTEGER NOT NULL REFERENCES habit_items(id) ON DELETE CASCADE,
      label       TEXT    NOT NULL,
      sort_order  INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_habit_choice_options_item
      ON habit_choice_options (item_id, sort_order);

    /* Single-row settings. The id check pins it to one row forever. */
    CREATE TABLE IF NOT EXISTS habit_settings (
      id                  INTEGER PRIMARY KEY CHECK (id = ${SETTINGS_ID}),
      day_boundary_minutes INTEGER NOT NULL,
      timezone            TEXT    NOT NULL
    );
  `);

  db.prepare(
    `INSERT OR IGNORE INTO habit_settings (id, day_boundary_minutes, timezone) VALUES (?, ?, ?)`,
  ).run(SETTINGS_ID, DEFAULT_DAY_BOUNDARY_MINUTES, DEFAULT_HABIT_TIMEZONE);
}

/* ── Validation ─────────────────────────────── */

function validName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HabitValidationError('name must be a string.', 'invalid_name');
  const name = raw.trim();
  if (name === '') throw new HabitValidationError('name is empty.', 'invalid_name');
  if (name.length > HABIT_NAME_MAX_LENGTH) {
    throw new HabitValidationError(`name is at most ${HABIT_NAME_MAX_LENGTH} characters.`, 'invalid_name');
  }
  return name;
}

function validDay(raw: unknown): string {
  if (!isHabitDay(raw)) throw new HabitValidationError('day must be a YYYY-MM-DD date.', 'invalid_day');
  return raw;
}

const METRIC_TYPES: readonly HabitMetricType[] = ['time', 'number', 'choice'];

function validMetricType(raw: unknown): HabitMetricType {
  if (typeof raw !== 'string' || !METRIC_TYPES.includes(raw as HabitMetricType)) {
    throw new HabitValidationError("metricType must be 'time', 'number' or 'choice'.", 'invalid_metric_type');
  }
  return raw as HabitMetricType;
}

function validLabel(raw: unknown): string {
  if (typeof raw !== 'string') throw new HabitValidationError('label must be a string.', 'invalid_label');
  const label = raw.trim();
  if (label === '') throw new HabitValidationError('label is empty.', 'invalid_label');
  if (label.length > HABIT_CHOICE_LABEL_MAX_LENGTH) {
    throw new HabitValidationError(`label is at most ${HABIT_CHOICE_LABEL_MAX_LENGTH} characters.`, 'invalid_label');
  }
  return label;
}

/* ── Items ──────────────────────────────────── */

const ITEM_SELECT = `
  SELECT i.*,
    (SELECT COUNT(*) FROM habit_completions c WHERE c.item_id = i.id) AS completion_count
  FROM habit_items i`;

export function getItem(db: Database.Database, id: number): HabitItemView | null {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as HabitItemRow | undefined;
  return row ? rowToItem(row) : null;
}

/**
 * Every item, in manual order. `includeArchived` is false by default (Today and the card want only
 * active items); the Habits manage tab passes true to list archived items too.
 */
export function listItems(
  db: Database.Database,
  opts: { includeArchived?: boolean } = {},
): HabitItemView[] {
  const where = opts.includeArchived ? '' : 'WHERE i.archived_at IS NULL';
  const rows = db
    .prepare(`${ITEM_SELECT} ${where} ORDER BY i.sort_order, i.id`)
    .all() as HabitItemRow[];
  return rows.map(rowToItem);
}

/**
 * Create a top-level item at the end of the list. A plain habit by default; passing
 * `kind: 'metric'` with a `metricType` creates a metric (PD-724). Nesting is a separate `moveItem`.
 */
export function createItem(
  db: Database.Database,
  input: { name?: unknown; kind?: unknown; metricType?: unknown },
  now = Date.now(),
): HabitItemView {
  const name = validName(input.name);
  const kind = input.kind === undefined ? 'habit' : input.kind;
  if (kind !== 'habit' && kind !== 'metric') {
    throw new HabitValidationError("kind must be 'habit' or 'metric'.", 'invalid_kind');
  }
  const metricType = kind === 'metric' ? validMetricType(input.metricType) : null;
  const nextOrder =
    (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM habit_items`).get() as { n: number })
      .n;
  const id = Number(
    db
      .prepare(
        `INSERT INTO habit_items (kind, metric_type, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(kind, metricType, name, nextOrder, now).lastInsertRowid,
  );
  return getItem(db, id) as HabitItemView;
}

/** Rename an item. Returns null if there is no such item. History is unaffected. */
export function renameItem(db: Database.Database, id: number, rawName: unknown): HabitItemView | null {
  const name = validName(rawName);
  const changed = db.prepare(`UPDATE habit_items SET name = ? WHERE id = ?`).run(name, id).changes;
  return changed > 0 ? getItem(db, id) : null;
}

/**
 * Reorder items to the given id order. Ids absent from the list keep their place after the ones
 * listed. Unknown ids are ignored. A whole-list write, matching the shell-layout reorder pattern.
 */
export function reorderItems(db: Database.Database, ids: unknown): HabitItemView[] {
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
    throw new HabitValidationError('ids must be an array of item ids.', 'invalid_ids');
  }
  const update = db.prepare(`UPDATE habit_items SET sort_order = ? WHERE id = ?`);
  db.transaction(() => {
    (ids as number[]).forEach((id, i) => update.run(i, id));
  })();
  return listItems(db, { includeArchived: true });
}

/** Every id in the subtree rooted at `rootId`, including `rootId`. Breadth-first over `parent_id`. */
function subtreeIds(db: Database.Database, rootId: number): number[] {
  const out = [rootId];
  const queue = [rootId];
  const childStmt = db.prepare(`SELECT id FROM habit_items WHERE parent_id = ?`);
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const r of childStmt.all(parent) as { id: number }[]) {
      out.push(r.id);
      queue.push(r.id);
    }
  }
  return out;
}

/**
 * Archive or restore an item. **Archiving a set archives its whole subtree** (PD-723) — the confirm
 * lives in the UI; restoring touches only the item itself, since a subtree may have been archived
 * piecemeal before. Returns the item, or null if there is no such item.
 */
export function archiveItem(
  db: Database.Database,
  id: number,
  archived: boolean,
  now = Date.now(),
): HabitItemView | null {
  if (!getItem(db, id)) return null;
  const ids = archived ? subtreeIds(db, id) : [id];
  const update = db.prepare(`UPDATE habit_items SET archived_at = ? WHERE id = ?`);
  db.transaction(() => {
    for (const i of ids) update.run(archived ? now : null, i);
  })();
  return getItem(db, id);
}

/** The ancestor ids of `id`, nearest first (via `parent_id`). Loop-guarded against a stored cycle. */
function ancestorIds(db: Database.Database, id: number): number[] {
  const parentStmt = db.prepare(`SELECT parent_id FROM habit_items WHERE id = ?`);
  const out: number[] = [];
  const seen = new Set<number>([id]);
  let row = parentStmt.get(id) as { parent_id: number | null } | undefined;
  while (row && row.parent_id !== null && !seen.has(row.parent_id)) {
    out.push(row.parent_id);
    seen.add(row.parent_id);
    row = parentStmt.get(row.parent_id) as { parent_id: number | null } | undefined;
  }
  return out;
}

/**
 * Move `itemId` under `parentId` (null = top level) and renumber the destination sibling group to
 * `siblingIds` order (PD-723). This is the one write behind "drag into / out of a set" and "reorder
 * within a set" (D-069). Cycles are rejected: an item may not be nested under itself or any of its
 * own descendants. A metric cannot contain items. Returns the full item list, or null if there is no
 * such item.
 */
export function moveItem(
  db: Database.Database,
  itemId: number,
  parentId: number | null,
  siblingIds: unknown,
): HabitItemView[] | null {
  if (!Number.isInteger(itemId)) {
    throw new HabitValidationError('itemId must be an item id.', 'invalid_item_id');
  }
  if (parentId !== null && !Number.isInteger(parentId)) {
    throw new HabitValidationError('parentId must be an item id or null.', 'invalid_parent_id');
  }
  if (siblingIds !== undefined && (!Array.isArray(siblingIds) || !siblingIds.every((n) => Number.isInteger(n)))) {
    throw new HabitValidationError('siblingIds must be an array of item ids.', 'invalid_sibling_ids');
  }
  if (!getItem(db, itemId)) return null;

  if (parentId !== null) {
    if (parentId === itemId) {
      throw new HabitValidationError('An item cannot be its own parent.', 'cycle');
    }
    const parent = getItem(db, parentId);
    if (!parent) {
      throw new HabitValidationError('No such parent item.', 'invalid_parent_id');
    }
    if (parent.kind === 'metric') {
      throw new HabitValidationError('A metric cannot contain items.', 'invalid_parent');
    }
    // Reject nesting a set under one of its own descendants: walk up from the new parent; if we meet
    // the item being moved, the move would close a cycle.
    if (ancestorIds(db, parentId).includes(itemId)) {
      throw new HabitValidationError('That move would nest a set inside itself.', 'cycle');
    }
  }

  const order = db.prepare(`UPDATE habit_items SET sort_order = ? WHERE id = ?`);
  db.transaction(() => {
    db.prepare(`UPDATE habit_items SET parent_id = ? WHERE id = ?`).run(parentId, itemId);
    if (Array.isArray(siblingIds)) {
      (siblingIds as number[]).forEach((sid, i) => order.run(i, sid));
    }
  })();
  return listItems(db, { includeArchived: true });
}

/**
 * Delete an item and all its completions (ON DELETE CASCADE handles the completions, and any
 * children, though this slice has none). Returns the completion count erased, or null if there was
 * no such item — the count is what the UI already named in its confirmation.
 */
export function deleteItem(db: Database.Database, id: number): { completionCount: number } | null {
  const item = getItem(db, id);
  if (!item) return null;
  db.prepare(`DELETE FROM habit_items WHERE id = ?`).run(id);
  return { completionCount: item.completionCount };
}

/* ── Completions ────────────────────────────── */

/**
 * Set whether `itemId` is done on `day`. **Idempotent set-state** (PROJECT.md §4 / D-092): replaying
 * the same message is harmless and the last write wins. Done → upsert with a fresh `completed_at`;
 * not done → delete. Returns the resulting completion, or null when cleared / no such item.
 */
export function setCompletion(
  db: Database.Database,
  input: { itemId?: unknown; day?: unknown; done?: unknown },
  now = Date.now(),
): { completion: HabitCompletion | null } | { notFound: true } {
  if (!Number.isInteger(input.itemId)) {
    throw new HabitValidationError('itemId must be an item id.', 'invalid_item_id');
  }
  const day = validDay(input.day);
  if (typeof input.done !== 'boolean') {
    throw new HabitValidationError('done must be a boolean.', 'invalid_done');
  }
  const itemId = input.itemId as number;
  if (!getItem(db, itemId)) return { notFound: true };

  if (input.done) {
    db.prepare(
      `INSERT INTO habit_completions (item_id, day, completed_at) VALUES (?, ?, ?)
       ON CONFLICT (item_id, day) DO UPDATE SET completed_at = excluded.completed_at`,
    ).run(itemId, day, now);
    const row = db
      .prepare(`SELECT * FROM habit_completions WHERE item_id = ? AND day = ?`)
      .get(itemId, day) as HabitCompletionRow;
    return { completion: rowToCompletion(row) };
  }

  db.prepare(`DELETE FROM habit_completions WHERE item_id = ? AND day = ?`).run(itemId, day);
  return { completion: null };
}

/** Completions whose day is in `[from, to]` inclusive. Both are habit days (`YYYY-MM-DD`). */
export function getCompletions(
  db: Database.Database,
  from: unknown,
  to: unknown,
): HabitCompletion[] {
  const fromDay = validDay(from);
  const toDay = validDay(to);
  const rows = db
    .prepare(`SELECT * FROM habit_completions WHERE day >= ? AND day <= ? ORDER BY day, item_id`)
    .all(fromDay, toDay) as HabitCompletionRow[];
  return rows.map(rowToCompletion);
}

/* ── Metrics: typed daily values + choice options (PD-724) ── */

/** The item, asserted to be a metric. Throws a validation error otherwise, or returns null if absent. */
function getMetricItem(db: Database.Database, itemId: number): HabitItemView | null {
  const item = getItem(db, itemId);
  if (!item) return null;
  if (item.kind !== 'metric' || item.metricType === null) {
    throw new HabitValidationError('That item is not a metric.', 'not_a_metric');
  }
  return item;
}

function metricValueCount(db: Database.Database, itemId: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM habit_metric_values WHERE item_id = ?`).get(itemId) as { n: number }
  ).n;
}

/**
 * Change a metric's type. **Refused once the metric has any value** (PD-724) — the stored values are
 * shaped for the old type, so a late type change would strand them. Returns the updated item, or null
 * if there is no such item.
 */
export function setMetricType(db: Database.Database, itemId: number, rawType: unknown): HabitItemView | null {
  if (!Number.isInteger(itemId)) {
    throw new HabitValidationError('itemId must be an item id.', 'invalid_item_id');
  }
  const item = getMetricItem(db, itemId);
  if (!item) return null;
  const metricType = validMetricType(rawType);
  if (metricType !== item.metricType && metricValueCount(db, itemId) > 0) {
    throw new HabitValidationError(
      "A metric's type cannot change once it has values.",
      'metric_type_locked',
    );
  }
  db.prepare(`UPDATE habit_items SET metric_type = ? WHERE id = ?`).run(metricType, itemId);
  return getItem(db, itemId);
}

/** Active option ids for a choice metric — the set a stored value must be a subset of. */
function optionIdSet(db: Database.Database, itemId: number): Set<number> {
  const rows = db.prepare(`SELECT id FROM habit_choice_options WHERE item_id = ?`).all(itemId) as {
    id: number;
  }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Set metric `itemId`'s value on habit day `day`. **Idempotent set-state** (PROJECT.md §4, D-092): a
 * replay is harmless and the last write wins. `value` is a string shaped for the metric's type, or
 * `null` to clear it — clearing deletes the row, and is distinct from a logged `'0'`. The value is
 * validated against the metric's type (and, for choice, against its option ids). Returns the resulting
 * value (null when cleared), or `{ notFound: true }` when there is no such item.
 */
export function setMetricValue(
  db: Database.Database,
  input: { itemId?: unknown; day?: unknown; value?: unknown },
  now = Date.now(),
): { value: HabitMetricValue | null } | { notFound: true } {
  if (!Number.isInteger(input.itemId)) {
    throw new HabitValidationError('itemId must be an item id.', 'invalid_item_id');
  }
  const day = validDay(input.day);
  const itemId = input.itemId as number;
  const item = getMetricItem(db, itemId);
  if (!item) return { notFound: true };

  const raw = input.value;
  if (raw === null) {
    db.prepare(`DELETE FROM habit_metric_values WHERE item_id = ? AND day = ?`).run(itemId, day);
    return { value: null };
  }

  const metricType = item.metricType as HabitMetricType;
  if (!isValidMetricValueFormat(metricType, raw)) {
    throw new HabitValidationError('value is not valid for this metric type.', 'invalid_metric_value');
  }
  if (metricType === 'choice') {
    const ids = parseChoiceValue(raw) as number[];
    const valid = optionIdSet(db, itemId);
    if (!ids.every((id) => valid.has(id))) {
      throw new HabitValidationError('value references an unknown choice option.', 'invalid_metric_value');
    }
  }

  const value = raw as string;
  db.prepare(
    `INSERT INTO habit_metric_values (item_id, day, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (item_id, day) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(itemId, day, value, now);
  const row = db
    .prepare(`SELECT * FROM habit_metric_values WHERE item_id = ? AND day = ?`)
    .get(itemId, day) as HabitMetricValueRow;
  return { value: rowToMetricValue(row) };
}

/** Metric values whose day is in `[from, to]` inclusive. Both are habit days (`YYYY-MM-DD`). */
export function getMetricValues(db: Database.Database, from: unknown, to: unknown): HabitMetricValue[] {
  const fromDay = validDay(from);
  const toDay = validDay(to);
  const rows = db
    .prepare(`SELECT * FROM habit_metric_values WHERE day >= ? AND day <= ? ORDER BY day, item_id`)
    .all(fromDay, toDay) as HabitMetricValueRow[];
  return rows.map(rowToMetricValue);
}

/** A metric's choice options in order. `includeArchived` false (the default) returns active ones only. */
export function listChoiceOptions(
  db: Database.Database,
  itemId: number,
  opts: { includeArchived?: boolean } = {},
): HabitChoiceOption[] {
  const where = opts.includeArchived ? '' : 'AND archived_at IS NULL';
  const rows = db
    .prepare(`SELECT * FROM habit_choice_options WHERE item_id = ? ${where} ORDER BY sort_order, id`)
    .all(itemId) as HabitChoiceOptionRow[];
  return rows.map(rowToChoiceOption);
}

/** Add a choice option at the end of the metric's option list. Returns it, or null if no such metric. */
export function createChoiceOption(
  db: Database.Database,
  itemId: number,
  rawLabel: unknown,
): HabitChoiceOption | null {
  if (!Number.isInteger(itemId)) {
    throw new HabitValidationError('itemId must be an item id.', 'invalid_item_id');
  }
  const item = getMetricItem(db, itemId);
  if (!item) return null;
  if (item.metricType !== 'choice') {
    throw new HabitValidationError('Only a choice metric has options.', 'not_a_choice_metric');
  }
  const label = validLabel(rawLabel);
  const nextOrder = (
    db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM habit_choice_options WHERE item_id = ?`)
      .get(itemId) as { n: number }
  ).n;
  const id = Number(
    db
      .prepare(`INSERT INTO habit_choice_options (item_id, label, sort_order) VALUES (?, ?, ?)`)
      .run(itemId, label, nextOrder).lastInsertRowid,
  );
  return rowToChoiceOption(
    db.prepare(`SELECT * FROM habit_choice_options WHERE id = ?`).get(id) as HabitChoiceOptionRow,
  );
}

function getChoiceOption(db: Database.Database, optionId: number): HabitChoiceOption | null {
  const row = db.prepare(`SELECT * FROM habit_choice_options WHERE id = ?`).get(optionId) as
    | HabitChoiceOptionRow
    | undefined;
  return row ? rowToChoiceOption(row) : null;
}

/** Rename a choice option. Returns it, or null if there is no such option. */
export function renameChoiceOption(
  db: Database.Database,
  optionId: number,
  rawLabel: unknown,
): HabitChoiceOption | null {
  const label = validLabel(rawLabel);
  const changed = db.prepare(`UPDATE habit_choice_options SET label = ? WHERE id = ?`).run(label, optionId).changes;
  return changed > 0 ? getChoiceOption(db, optionId) : null;
}

/** Archive or restore a choice option (kept for history). Returns it, or null if there is no such option. */
export function archiveChoiceOption(
  db: Database.Database,
  optionId: number,
  archived: boolean,
  now = Date.now(),
): HabitChoiceOption | null {
  const changed = db
    .prepare(`UPDATE habit_choice_options SET archived_at = ? WHERE id = ?`)
    .run(archived ? now : null, optionId).changes;
  return changed > 0 ? getChoiceOption(db, optionId) : null;
}

/** Delete a choice option. Past values keep its id (shown without a label). Returns true if removed. */
export function deleteChoiceOption(db: Database.Database, optionId: number): boolean {
  return db.prepare(`DELETE FROM habit_choice_options WHERE id = ?`).run(optionId).changes > 0;
}

/* ── Schedules (PD-722, D-095) ──────────────── */

/** Every schedule row for one item, oldest effective day first. */
export function listSchedules(db: Database.Database, itemId: number): HabitSchedule[] {
  const rows = db
    .prepare(`SELECT * FROM habit_schedules WHERE item_id = ? ORDER BY effective_from_day, id`)
    .all(itemId) as HabitScheduleRow[];
  return rows.map(rowToSchedule);
}

/** Every schedule row, for the manage tab (grouped client-side) and the Today view. */
export function listAllSchedules(db: Database.Database): HabitSchedule[] {
  const rows = db
    .prepare(`SELECT * FROM habit_schedules ORDER BY item_id, effective_from_day, id`)
    .all() as HabitScheduleRow[];
  return rows.map(rowToSchedule);
}

/**
 * Set a habit's schedule, effective from today's habit day (D-095). Inserts a new row, or replaces
 * today's if one already exists — a past row is never touched, so history stays judged by the
 * schedule that applied then. Returns the stored schedule, or null if there is no such item.
 */
export function setSchedule(
  db: Database.Database,
  itemId: number,
  input: { kind?: unknown; daysMask?: unknown; perWeekN?: unknown },
  now = Date.now(),
): HabitSchedule | null {
  if (!Number.isInteger(itemId)) {
    throw new HabitValidationError('itemId must be an item id.', 'invalid_item_id');
  }
  if (input.kind !== 'days_of_week' && input.kind !== 'per_week') {
    throw new HabitValidationError("kind must be 'days_of_week' or 'per_week'.", 'invalid_schedule_kind');
  }

  let daysMask: number | null = null;
  let perWeekN: number | null = null;
  if (input.kind === 'days_of_week') {
    if (!isValidDaysMask(input.daysMask)) {
      throw new HabitValidationError('daysMask must be an integer in [1, 127].', 'invalid_days_mask');
    }
    daysMask = input.daysMask;
  } else {
    if (!isValidPerWeekN(input.perWeekN)) {
      throw new HabitValidationError('perWeekN must be an integer in [1, 7].', 'invalid_per_week_n');
    }
    perWeekN = input.perWeekN;
  }

  if (!getItem(db, itemId)) return null;

  const today = habitDay(now, getSettings(db));
  db.prepare(
    `INSERT INTO habit_schedules (item_id, effective_from_day, kind, days_mask, per_week_n)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (item_id, effective_from_day)
       DO UPDATE SET kind = excluded.kind, days_mask = excluded.days_mask, per_week_n = excluded.per_week_n`,
  ).run(itemId, today, input.kind, daysMask, perWeekN);

  const row = db
    .prepare(`SELECT * FROM habit_schedules WHERE item_id = ? AND effective_from_day = ?`)
    .get(itemId, today) as HabitScheduleRow;
  return rowToSchedule(row);
}

/* ── Today view (PD-722, D-095) ─────────────── */

/**
 * Everything the Today surface needs for the current habit day, computed server-side because the
 * server owns full completion history: for each active item, the schedule in force, whether it is
 * due, this week's per-week progress, and the current/longest streak. The client stays thin and
 * "today" matches the server's `habitDay` (D-092).
 */
export function getTodayView(db: Database.Database, now = Date.now()): HabitTodayView {
  const settings = getSettings(db);
  const today = habitDay(now, settings);
  const items = listItems(db); // active only, ordered by sort_order

  const schedulesByItem = new Map<number, HabitSchedule[]>();
  for (const s of listAllSchedules(db)) {
    const list = schedulesByItem.get(s.itemId) ?? [];
    list.push(s);
    schedulesByItem.set(s.itemId, list);
  }

  const daysByItem = new Map<number, string[]>();
  const completionRows = db
    .prepare(`SELECT item_id, day FROM habit_completions`)
    .all() as { item_id: number; day: string }[];
  for (const c of completionRows) {
    const list = daysByItem.get(c.item_id) ?? [];
    list.push(c.day);
    daysByItem.set(c.item_id, list);
  }

  // Children of each item, in sibling order (active items only — an archived subtree is off Today).
  const childrenOf = new Map<number | null, HabitItemView[]>();
  for (const it of items) {
    const list = childrenOf.get(it.parentId) ?? [];
    list.push(it);
    childrenOf.set(it.parentId, list);
  }

  // A set's derived state (due/done/progress/streak, PD-723) needs its whole subtree's schedules and
  // completion history, so build a HabitHistoryNode once per item and memoise it.
  const historyCache = new Map<number, HabitHistoryNode>();
  const buildHistory = (it: HabitItemView): HabitHistoryNode => {
    const cached = historyCache.get(it.id);
    if (cached) return cached;
    const node: HabitHistoryNode = {
      kind: it.kind,
      children: (childrenOf.get(it.id) ?? []).map(buildHistory),
      schedules: schedulesByItem.get(it.id) ?? [],
      completionDays: new Set(daysByItem.get(it.id) ?? []),
    };
    historyCache.set(it.id, node);
    return node;
  };

  // Flat rows carry parentId, so the client rebuilds the tree. Metrics are a separate section below.
  const rows: HabitTodayRow[] = items
    .filter((it) => it.kind !== 'metric')
    .map((item) => {
      const isSet = (childrenOf.get(item.id) ?? []).length > 0;
      if (isSet) {
        const history = buildHistory(item);
        const dayNode = projectHabitDay(history, today);
        return {
          item,
          schedule: null,
          due: nodeDue(dayNode),
          completedToday: nodeDone(dayNode),
          perWeek: null,
          streak: setStreak(history, today),
          isSet: true,
          progress: nodeProgress(dayNode),
        };
      }
      const schedules = schedulesByItem.get(item.id) ?? [];
      const days = daysByItem.get(item.id) ?? [];
      return {
        item,
        schedule: scheduleForDay(schedules, today),
        due: isDue(schedules, today),
        completedToday: days.includes(today),
        perWeek: perWeekProgress(schedules, today, days),
        streak: streak(schedules, days, today),
        isSet: false,
        progress: null,
      };
    });

  // Metrics (PD-724): active metrics with today's value and, for choice, their active options. They
  // are never due and have no streak, so they ride a separate array rather than a HabitTodayRow.
  const valueToday = new Map<number, string>();
  for (const r of db
    .prepare(`SELECT item_id, value FROM habit_metric_values WHERE day = ?`)
    .all(today) as { item_id: number; value: string }[]) {
    valueToday.set(r.item_id, r.value);
  }
  const metrics: HabitMetricTodayRow[] = items
    .filter((it) => it.kind === 'metric')
    .map((item) => ({
      item,
      value: valueToday.get(item.id) ?? null,
      options: item.metricType === 'choice' ? listChoiceOptions(db, item.id) : [],
    }));

  return { day: today, rows, metrics };
}

/* ── Settings ───────────────────────────────── */

export function getSettings(db: Database.Database): HabitSettings {
  const row = db
    .prepare(`SELECT day_boundary_minutes, timezone FROM habit_settings WHERE id = ?`)
    .get(SETTINGS_ID) as HabitSettingsRow;
  return { dayBoundaryMinutes: row.day_boundary_minutes, timezone: row.timezone };
}

export function patchSettings(
  db: Database.Database,
  input: { dayBoundaryMinutes?: unknown; timezone?: unknown },
): HabitSettings {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (input.dayBoundaryMinutes !== undefined) {
    if (!isValidDayBoundaryMinutes(input.dayBoundaryMinutes)) {
      throw new HabitValidationError(
        'dayBoundaryMinutes must be a whole number of minutes in [0, 1440).',
        'invalid_day_boundary',
      );
    }
    sets.push('day_boundary_minutes = ?');
    params.push(input.dayBoundaryMinutes);
  }
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) {
      throw new HabitValidationError('timezone must be a valid IANA timezone.', 'invalid_timezone');
    }
    sets.push('timezone = ?');
    params.push(input.timezone);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE habit_settings SET ${sets.join(', ')} WHERE id = ?`).run(...params, SETTINGS_ID);
  }
  return getSettings(db);
}
