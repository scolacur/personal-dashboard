import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import { listListings } from './store';

// These run against a hand-built copy of the PD-437 schema, because that is what is on the NAS
// with 58 real rows in it. `bootstrapSchema` is called on every boot, so a mistake here is a
// mistake against live data — that is why the migrations get their own file.

let db: Database.Database;

/** The shape PD-437 shipped: `module`, no `private_notes`, and a UNIQUE identity index. */
function legacySchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE buy_sell_trade_listings (
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
    CREATE UNIQUE INDEX idx_bst_listings_identity
      ON buy_sell_trade_listings (
        type COLLATE NOCASE,
        IFNULL(manufacturer, '') COLLATE NOCASE,
        module COLLATE NOCASE
      );
  `);
}

function seedLegacy(rows: [type: string, manufacturer: string | null, module: string][]): void {
  const ins = db.prepare(
    `INSERT INTO buy_sell_trade_listings (type, manufacturer, module, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0)`,
  );
  for (const r of rows) ins.run(...r);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

describe('migrating a PD-437 database', () => {
  it('renames module → item without losing a row', () => {
    legacySchema(db);
    seedLegacy([
      ['WTS', 'Make Noise', 'Maths'],
      ['WTS', 'Alright Devices', 'Chronoblob'],
    ]);

    bootstrapSchema(db);

    expect(listListings(db).map((l) => l.item).sort()).toEqual(['Chronoblob', 'Maths']);
  });

  it('adds private_notes and leaves the existing notes alone as the public field', () => {
    legacySchema(db);
    db.prepare(
      `INSERT INTO buy_sell_trade_listings (type, module, notes, created_at, updated_at)
       VALUES ('WTS', 'Maths', 'og box', 0, 0)`,
    ).run();

    bootstrapSchema(db);

    const [l] = listListings(db);
    expect(l.notes).toBe('og box');
    expect(l.privateNotes).toBeNull();
  });

  it('converts WTT rows to WTB', () => {
    legacySchema(db);
    seedLegacy([
      ['WTT', null, 'acidlab m303'],
      ['WTS', 'Make Noise', 'Maths'],
    ]);

    bootstrapSchema(db);

    const wants = listListings(db).filter((l) => l.type === 'WTB');
    expect(wants.map((w) => w.item)).toEqual(['acidlab m303']);
  });

  // The one that could have failed at boot: the old UNIQUE index is on (type, manufacturer,
  // module), so an item recorded as both WTB and WTT would collide on the way across. Those are
  // the same want written twice, so the WTT row goes.
  it('merges a want recorded as both WTB and WTT instead of failing', () => {
    legacySchema(db);
    seedLegacy([
      ['WTB', 'Intellijel', 'Quadrax'],
      ['WTT', 'Intellijel', 'Quadrax'],
    ]);

    expect(() => bootstrapSchema(db)).not.toThrow();

    const rows = listListings(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'WTB', item: 'Quadrax' });
  });

  it('drops the uniqueness constraint so a second copy of an item can be added', () => {
    legacySchema(db);
    seedLegacy([['WTS', 'Make Noise', 'Maths']]);

    bootstrapSchema(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO buy_sell_trade_listings (type, manufacturer, item, condition, created_at, updated_at)
           VALUES ('WTS', 'Make Noise', 'Maths', 'Good', 0, 0)`,
        )
        .run(),
    ).not.toThrow();
    expect(listListings(db)).toHaveLength(2);
  });

  it('is idempotent — a second boot changes nothing', () => {
    legacySchema(db);
    seedLegacy([['WTT', null, 'acidlab m303']]);

    bootstrapSchema(db);
    const after = listListings(db);
    bootstrapSchema(db);

    expect(listListings(db)).toEqual(after);
  });
});

describe('a fresh database', () => {
  it('bootstraps straight to the current shape, migrations no-opping', () => {
    expect(() => bootstrapSchema(db)).not.toThrow();
    const cols = (
      db.prepare('PRAGMA table_info(buy_sell_trade_listings)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('item');
    expect(cols).toContain('private_notes');
    expect(cols).not.toContain('module');
  });
});
