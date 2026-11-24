import type Database from 'better-sqlite3';
import { SLEEP_DEFAULT_TAGS, SLEEP_RESTED_MAX, SLEEP_RESTED_MIN, SLEEP_TAG_COUNT_MAX, SLEEP_TAG_COUNT_MIN } from '@dashboard/shared';

/**
 * Sleep Journal schema (see `widgets/sleep-journal/PROJECT.md` §2).
 *
 * One row per night, unique on the wake date. `client_id` is the id that created the night; every
 * client id that has ever written to it (the creator and later upserts) is remembered in
 * `sleep_journal_entry_clients`, so an outbox replay of any of them is a no-op.
 */
export function bootstrapSchema(db: Database.Database, now: number = Date.now()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sleep_journal_tags (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      hidden_at  INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sleep_journal_entries (
      id         INTEGER PRIMARY KEY,
      client_id  TEXT    NOT NULL UNIQUE,
      wake_date  TEXT    NOT NULL UNIQUE,
      sleep_at   INTEGER NOT NULL,
      wake_at    INTEGER NOT NULL,
      rested     INTEGER NOT NULL CHECK (rested BETWEEN ${SLEEP_RESTED_MIN} AND ${SLEEP_RESTED_MAX}),
      notes      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (sleep_at < wake_at)
    );

    CREATE TABLE IF NOT EXISTS sleep_journal_entry_clients (
      client_id TEXT    PRIMARY KEY,
      entry_id  INTEGER NOT NULL REFERENCES sleep_journal_entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sleep_journal_entry_tags (
      entry_id INTEGER NOT NULL REFERENCES sleep_journal_entries(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES sleep_journal_tags(id),
      count    INTEGER NOT NULL CHECK (count BETWEEN ${SLEEP_TAG_COUNT_MIN} AND ${SLEEP_TAG_COUNT_MAX}),
      PRIMARY KEY (entry_id, tag_id)
    );
  `);

  // Seed the default tags. OR IGNORE means a default the user has hidden stays hidden across boots.
  // `now` is injectable so a spec with a fixed clock can boot the schema before its own writes;
  // otherwise tag order (by created_at) would depend on the wall clock at test time.
  const seed = db.prepare(`INSERT OR IGNORE INTO sleep_journal_tags (name, created_at) VALUES (?, ?)`);
  SLEEP_DEFAULT_TAGS.forEach((name, i) => seed.run(name, now + i));
}
