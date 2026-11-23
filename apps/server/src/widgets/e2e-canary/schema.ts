import type Database from 'better-sqlite3';

/**
 * E2E Canary schema (see `widgets/e2e-canary/PROJECT.md`).
 *
 * Owned by the scaffold on purpose: every widget `schema.ts` is a sensitive path (D-047), so if a
 * feature ticket had to create this table, every run would stop at path-guard for a reason
 * that has nothing to do with what the test measures.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS e2e_canary_items (
      id         INTEGER PRIMARY KEY,
      label      TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_e2e_canary_items_created
      ON e2e_canary_items (created_at DESC);
  `);
}
