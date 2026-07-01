import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, columnExists, addColumn } from './migrate';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migrate', () => {
  it('runs a step once and records it in the ledger', () => {
    const db = memDb();
    let runs = 0;
    migrate(db, 'step-1', () => {
      runs++;
    });
    migrate(db, 'step-1', () => {
      runs++;
    });
    expect(runs).toBe(1);
    const ledger = db.prepare('SELECT id FROM _migrations').all() as { id: string }[];
    expect(ledger.map((r) => r.id)).toEqual(['step-1']);
  });

  it('rolls back and does NOT record a step that throws (so it retries)', () => {
    const db = memDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    db.prepare('INSERT INTO t (a) VALUES (?)').run('keep-me');

    expect(() =>
      migrate(db, 'bad', (d) => {
        addColumn(d, 't', 'b', 'TEXT'); // partial work…
        throw new Error('boom'); // …then fail
      }),
    ).toThrow('boom');

    // Column add was rolled back and the step is not recorded.
    expect(columnExists(db, 't', 'b')).toBe(false);
    expect(db.prepare('SELECT 1 FROM _migrations WHERE id = ?').get('bad')).toBeUndefined();
    // The original data is untouched.
    expect((db.prepare('SELECT a FROM t').get() as { a: string }).a).toBe('keep-me');

    // Retrying (without the throw) succeeds.
    migrate(db, 'bad', (d) => addColumn(d, 't', 'b', 'TEXT'));
    expect(columnExists(db, 't', 'b')).toBe(true);
  });
});

describe('addColumn (non-destructive evolution)', () => {
  it('adds a missing column while preserving existing rows', () => {
    const db = memDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    db.prepare('INSERT INTO t (a) VALUES (?)').run('row-1');
    db.prepare('INSERT INTO t (a) VALUES (?)').run('row-2');

    addColumn(db, 't', 'b', 'INTEGER');

    expect(columnExists(db, 't', 'b')).toBe(true);
    const rows = db.prepare('SELECT a, b FROM t ORDER BY id').all() as { a: string; b: number | null }[];
    expect(rows).toEqual([
      { a: 'row-1', b: null },
      { a: 'row-2', b: null },
    ]);
  });

  it('is a no-op when the column already exists', () => {
    const db = memDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    addColumn(db, 't', 'a', 'TEXT'); // already present
    const cols = db.prepare('PRAGMA table_info(t)').all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'a')).toHaveLength(1);
  });
});
