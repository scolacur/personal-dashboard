import type Database from 'better-sqlite3';
import type { WidgetUsage } from '@dashboard/shared';

/**
 * Widget-usage store (PD-751, Home shows recently used widgets).
 *
 * Shell infrastructure like the page-membership store beside it (`shell-layout.ts`): usage is
 * not any one widget's concern, and Home reads it to decide what to show. Server-side rather than
 * `localStorage` so "recently used" follows you across devices, as page membership does (D-073).
 *
 * One row per widget, upserted on each use. The table cannot grow past the number of distinct
 * widget ids ever recorded, and ids are validated by the route — so no pruning is needed. A row
 * for a widget later deleted from the registry is harmless: the client filters against the
 * registry before showing anything.
 *
 * `widget_id` is plain TEXT, not a foreign key: the registry lives in `apps/web` code, not in a
 * table the server could reference.
 */

interface WidgetUsageRow {
  widget_id: string;
  last_used_at: number;
  use_count: number;
}

function rowToUsage(r: WidgetUsageRow): WidgetUsage {
  return { widgetId: r.widget_id, lastUsedAt: r.last_used_at, useCount: r.use_count };
}

/** Hard ceiling on a GET's `limit`. Home asks for a handful; anything bigger is a mistake. */
export const MAX_USAGE_LIMIT = 100;

export function bootstrapWidgetUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS widget_usage (
      widget_id    TEXT    PRIMARY KEY,
      last_used_at INTEGER NOT NULL,
      use_count    INTEGER NOT NULL DEFAULT 0
    );

    /* The only read is "most recent first". */
    CREATE INDEX IF NOT EXISTS idx_widget_usage_last_used
      ON widget_usage (last_used_at DESC);
  `);
}

/**
 * Record one use of `widgetId` at `now`.
 *
 * `MAX(...)` rather than a plain overwrite so a late-arriving request with an older timestamp can
 * never move a widget *back* in the recency order. The server supplies `now`; the client never
 * sends a timestamp, so device clock skew cannot reorder Home either.
 */
export function recordWidgetUse(
  db: Database.Database,
  widgetId: string,
  now: number = Date.now(),
): WidgetUsage {
  const row = db
    .prepare(
      `INSERT INTO widget_usage (widget_id, last_used_at, use_count)
       VALUES (?, ?, 1)
       ON CONFLICT (widget_id) DO UPDATE SET
         last_used_at = MAX(last_used_at, excluded.last_used_at),
         use_count    = use_count + 1
       RETURNING widget_id, last_used_at, use_count`,
    )
    .get(widgetId, now) as WidgetUsageRow;
  return rowToUsage(row);
}

/** Usage rows, most recently used first. Ties broken by id so the order is stable. */
export function listWidgetUsage(
  db: Database.Database,
  limit: number = MAX_USAGE_LIMIT,
): WidgetUsage[] {
  const capped = Math.max(1, Math.min(MAX_USAGE_LIMIT, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT widget_id, last_used_at, use_count FROM widget_usage
       ORDER BY last_used_at DESC, widget_id ASC
       LIMIT ?`,
    )
    .all(capped) as WidgetUsageRow[];
  return rows.map(rowToUsage);
}
