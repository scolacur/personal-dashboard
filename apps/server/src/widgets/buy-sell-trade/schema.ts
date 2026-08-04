import type Database from 'better-sqlite3';

/** Buy/Sell/Trade widget tables (PD-437). Namespaced `buy_sell_trade_*` per PROJECT.md §2;
 *  times are unix ms integers per §5.
 *
 *  The UNIQUE index is what makes the CSV import idempotent: re-pasting the same export
 *  updates rows instead of duplicating them. It is COLLATE NOCASE because the same module
 *  typed "Maths" one month and "maths" the next is the same listing, and a case-sensitive
 *  key would silently double it. */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS buy_sell_trade_listings (
      id           INTEGER PRIMARY KEY,
      type         TEXT    NOT NULL,
      manufacturer TEXT,
      module       TEXT    NOT NULL,
      price        TEXT,
      condition    TEXT,
      notes        TEXT,
      location     TEXT,
      sale_status  TEXT,
      category     TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bst_listings_identity
      ON buy_sell_trade_listings (
        type COLLATE NOCASE,
        IFNULL(manufacturer, '') COLLATE NOCASE,
        module COLLATE NOCASE
      );

    CREATE INDEX IF NOT EXISTS idx_bst_listings_type ON buy_sell_trade_listings (type);

    CREATE TABLE IF NOT EXISTS buy_sell_trade_settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      terms      TEXT    NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);

  // Single settings row, created empty so reads never have to handle "no row yet".
  db.prepare(
    'INSERT OR IGNORE INTO buy_sell_trade_settings (id, terms, updated_at) VALUES (1, ?, ?)',
  ).run('', Date.now());
}
