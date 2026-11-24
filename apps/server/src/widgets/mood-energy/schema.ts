import type Database from 'better-sqlite3';
import { MOOD_ENERGY_DEFAULT_TAGS, MOOD_ENERGY_MAX, MOOD_ENERGY_MIN } from '@dashboard/shared';

/**
 * Mood & Energy schema (see `widgets/mood-energy/PROJECT.md` §2).
 *
 * One entry per habit day (`day` is UNIQUE). Saving again for a day updates its row, so the outbox's
 * client ids can't live on the entry alone: every save's client id is kept in
 * `mood_energy_client_ids`, which is what makes a replayed save a no-op even after a later save for
 * the same day.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mood_energy_tags (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      hidden_at  INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mood_energy_entries (
      id          INTEGER PRIMARY KEY,
      day         TEXT    NOT NULL UNIQUE,
      recorded_at INTEGER NOT NULL,
      mood        INTEGER NOT NULL CHECK (mood BETWEEN ${MOOD_ENERGY_MIN} AND ${MOOD_ENERGY_MAX}),
      energy      INTEGER NOT NULL CHECK (energy BETWEEN ${MOOD_ENERGY_MIN} AND ${MOOD_ENERGY_MAX}),
      note        TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mood_energy_entry_tags (
      entry_id INTEGER NOT NULL REFERENCES mood_energy_entries(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES mood_energy_tags(id),
      PRIMARY KEY (entry_id, tag_id)
    );

    /* Every save's client id, so the outbox can replay any of them safely. */
    CREATE TABLE IF NOT EXISTS mood_energy_client_ids (
      client_id  TEXT    PRIMARY KEY,
      entry_id   INTEGER NOT NULL REFERENCES mood_energy_entries(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `);

  // OR IGNORE: a default the user has hidden stays hidden across boots.
  const seed = db.prepare(`INSERT OR IGNORE INTO mood_energy_tags (name, created_at) VALUES (?, ?)`);
  const now = Date.now();
  MOOD_ENERGY_DEFAULT_TAGS.forEach((name, i) => seed.run(name, now + i));
}
