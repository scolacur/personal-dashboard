import type Database from 'better-sqlite3';

// Minimal, non-destructive migration framework.
//
// The rule: schema only ever grows. Migrations create tables or ADD columns —
// never drop or recreate, so no migration can lose existing data. Each step runs
// at most once (tracked in `_migrations`) inside a transaction, so a failed step
// rolls back cleanly and is retried on the next boot.

function ensureLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

/** Run a migration step once, transactionally, recording it in the ledger. */
export function migrate(db: Database.Database, id: string, fn: (db: Database.Database) => void): void {
  ensureLedger(db);
  const already = db.prepare('SELECT 1 FROM _migrations WHERE id = ?').get(id);
  if (already) return;
  const run = db.transaction(() => {
    fn(db);
    db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
  });
  run();
}

/** True if `column` already exists on `table`. */
export function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Additive column add — a no-op if the column is already present. */
export function addColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
