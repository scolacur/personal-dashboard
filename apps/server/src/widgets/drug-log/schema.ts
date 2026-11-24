import type Database from 'better-sqlite3';
import { DRUG_LOG_DEFAULT_DRUG } from '@dashboard/shared';

/** The `drug_log_meta` key that records the default drug has been seeded (ever). */
export const SEEDED_KEY = 'seeded_default_drug';

/**
 * Drug Log schema (see `widgets/drug-log/PROJECT.md` §2). PD-975 (Drug log widget).
 *
 * Seeding is **once per database**, not "whenever the table is empty": the marker row in
 * `drug_log_meta` is written on the first boot, so deleting Weed later does not bring it back on
 * the next restart.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drug_log_drugs (
      id          INTEGER PRIMARY KEY,
      label       TEXT    NOT NULL,
      color       TEXT    NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drug_log_events (
      id          INTEGER PRIMARY KEY,
      client_id   TEXT    NOT NULL UNIQUE,
      drug_id     INTEGER NOT NULL REFERENCES drug_log_drugs(id) ON DELETE CASCADE,
      recorded_at INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    /* Every read — today's counts, the By Day list, the By Drug calendar — is by time. */
    CREATE INDEX IF NOT EXISTS idx_drug_log_events_recorded
      ON drug_log_events (recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_drug_log_events_drug
      ON drug_log_events (drug_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS drug_log_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.transaction(() => {
    const seeded = db.prepare(`SELECT 1 FROM drug_log_meta WHERE key = ?`).get(SEEDED_KEY);
    if (seeded) return;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM drug_log_drugs`).get() as { n: number };
    if (n === 0) {
      db.prepare(
        `INSERT INTO drug_log_drugs (label, color, sort_order, created_at) VALUES (?, ?, 0, ?)`,
      ).run(DRUG_LOG_DEFAULT_DRUG.label, DRUG_LOG_DEFAULT_DRUG.color, Date.now());
    }
    db.prepare(`INSERT INTO drug_log_meta (key, value) VALUES (?, ?)`).run(SEEDED_KEY, '1');
  })();
}
