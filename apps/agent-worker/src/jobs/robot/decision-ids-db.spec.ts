import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { allocateDecisionId, decisionCounterReady } from './decision-ids-db';

let db: Database.Database;

/**
 * Stand in for what the web process bootstraps in `apps/server/src/lib/decision-ids.ts`.
 *
 * Written out rather than imported because the worker cannot import from `apps/server` — the same
 * split `holds-db.spec.ts` lives with. If this drifts from the server's DDL the tool breaks in
 * production while both suites stay green, so keep it a literal copy of the real thing.
 */
function serverBootstrap(target: Database.Database, seed = 79): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS decision_id_counter (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      last_num INTEGER NOT NULL
    );
  `);
  target.prepare('INSERT OR IGNORE INTO decision_id_counter (id, last_num) VALUES (1, ?)').run(seed);
}

beforeEach(() => {
  db = new Database(':memory:');
});

describe('decisionCounterReady', () => {
  it('is false before the web process has bootstrapped', () => {
    expect(decisionCounterReady(db)).toBe(false);
  });

  it('is true once the counter exists', () => {
    serverBootstrap(db);
    expect(decisionCounterReady(db)).toBe(true);
  });
});

describe('allocateDecisionId', () => {
  it('hands out the next id, zero-padded', () => {
    serverBootstrap(db, 79);
    expect(allocateDecisionId(db)).toBe('D-080');
    expect(allocateDecisionId(db)).toBe('D-081');
  });

  it('never returns the same id twice', () => {
    serverBootstrap(db);
    const ids = Array.from({ length: 100 }, () => allocateDecisionId(db));
    expect(new Set(ids).size).toBe(100);
  });

  it('continues the server’s sequence rather than starting its own', () => {
    // The two processes share one counter. A worker that seeded its own would re-issue every id
    // the server had already handed to a human author.
    serverBootstrap(db, 79);
    db.prepare('UPDATE decision_id_counter SET last_num = 86 WHERE id = 1').run();
    expect(allocateDecisionId(db)).toBe('D-087');
  });

  it('returns null rather than creating a counter when the web process has not run', () => {
    // Seeding here would start from a number this process has no way to know is free.
    expect(allocateDecisionId(db)).toBeNull();
    expect(decisionCounterReady(db)).toBe(false);
  });

  it('returns null when the table exists but its row is gone', () => {
    serverBootstrap(db);
    db.prepare('DELETE FROM decision_id_counter').run();
    expect(allocateDecisionId(db)).toBeNull();
  });

  it('pads past three digits rather than wrapping', () => {
    serverBootstrap(db, 999);
    expect(allocateDecisionId(db)).toBe('D-1000');
  });
});

/**
 * The drift guard the split makes necessary.
 *
 * The worker writes raw SQL against a table the *server* owns, and nothing in either type system
 * connects the two. Renaming the table or its column in `apps/server` would leave both suites green
 * and break allocation only in production, where the two processes actually share a file. Reading
 * the server's source is worth the small ugliness: it is the only place the coupling is checkable.
 */
describe('the server still owns the schema this file assumes', () => {
  function repoRoot(): string {
    let dir = path.resolve(process.cwd());
    for (;;) {
      if (existsSync(path.join(dir, 'DECISIONS')) && existsSync(path.join(dir, 'DECISIONS.md'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`no repo root above ${process.cwd()}`);
      dir = parent;
    }
  }

  it('declares decision_id_counter with the columns the worker reads', () => {
    const src = readFileSync(path.join(repoRoot(), 'apps/server/src/lib/decision-ids.ts'), 'utf8');

    // If any of these fail, the worker's UPDATE in decision-ids-db.ts must change to match.
    expect(src).toContain('CREATE TABLE IF NOT EXISTS decision_id_counter');
    expect(src).toContain('last_num');
    expect(src).toContain('CHECK (id = 1)');
  });

  it('still allocates with a single UPDATE … RETURNING, as this file does', () => {
    // Two processes now increment this counter. If the server were changed to read-then-write, the
    // pair would race for real — the reason both sides use one statement rather than two.
    const src = readFileSync(path.join(repoRoot(), 'apps/server/src/lib/decision-ids.ts'), 'utf8');
    expect(src).toContain('UPDATE decision_id_counter SET last_num = last_num + 1 WHERE id = 1 RETURNING last_num');
  });
});
