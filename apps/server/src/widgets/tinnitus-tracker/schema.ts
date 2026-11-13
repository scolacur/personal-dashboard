import type Database from 'better-sqlite3';
import { TINNITUS_DEFAULT_TAGS, TINNITUS_MAX, TINNITUS_MIN } from '@dashboard/shared';

/**
 * Tinnitus Tracker schema (see `widgets/tinnitus-tracker/PROJECT.md` §2).
 *
 * Entries are timestamped events, many per day, so they live here rather than in the shared
 * one-row-per-day daily-log store (D-090). PD-706 correlates the two.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tinnitus_tracker_tags (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      hidden_at  INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tinnitus_tracker_entries (
      id          INTEGER PRIMARY KEY,
      client_id   TEXT    NOT NULL UNIQUE,
      recorded_at INTEGER NOT NULL,
      intensity   INTEGER NOT NULL CHECK (intensity BETWEEN ${TINNITUS_MIN} AND ${TINNITUS_MAX}),
      notes       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    /* The list, and every correlation PD-706 will run, reads entries by time. */
    CREATE INDEX IF NOT EXISTS idx_tinnitus_tracker_entries_recorded
      ON tinnitus_tracker_entries (recorded_at DESC);

    CREATE TABLE IF NOT EXISTS tinnitus_tracker_entry_tags (
      entry_id INTEGER NOT NULL REFERENCES tinnitus_tracker_entries(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tinnitus_tracker_tags(id),
      PRIMARY KEY (entry_id, tag_id)
    );
  `);

  // Seed the default tags. OR IGNORE means a default the user has hidden stays hidden across boots.
  const seed = db.prepare(`INSERT OR IGNORE INTO tinnitus_tracker_tags (name, created_at) VALUES (?, ?)`);
  const now = Date.now();
  TINNITUS_DEFAULT_TAGS.forEach((name, i) => seed.run(name, now + i));
}
