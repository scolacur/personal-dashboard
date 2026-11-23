import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';

describe('e2e-canary schema', () => {
  it('creates the items table, idempotently', () => {
    const db = new Database(':memory:');
    bootstrapSchema(db);
    bootstrapSchema(db);
    const cols = (db.prepare('PRAGMA table_info(e2e_canary_items)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['id', 'label', 'created_at']);
  });
});
