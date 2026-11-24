import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import {
  createDrug,
  createEvent,
  deleteDrug,
  deleteEvent,
  getDrug,
  listDrugs,
  listEvents,
  updateDrug,
  updateEvent,
  ValidationError,
} from './store';

let db: Database.Database;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
});

const weed = () => listDrugs(db)[0];

function tap(overrides: Record<string, unknown> = {}) {
  return createEvent(db, { clientId: 'c1', drugId: weed().id, recordedAt: NOW, ...overrides }, NOW);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.code;
    throw e;
  }
  return null;
}

describe('seeding', () => {
  it('seeds exactly one green Weed button on first boot', () => {
    expect(listDrugs(db)).toMatchObject([
      { label: 'Weed', color: '#2e9e5b', archivedAt: null, eventCount: 0 },
    ]);
  });

  it('re-booting does not duplicate it', () => {
    bootstrapSchema(db);
    expect(listDrugs(db)).toHaveLength(1);
  });

  it('seeds once: deleting Weed and re-booting does not bring it back', () => {
    deleteDrug(db, weed().id);
    bootstrapSchema(db);
    expect(listDrugs(db)).toEqual([]);
  });

  it('does not seed into a database that already has drugs', () => {
    const fresh = new Database(':memory:');
    fresh.exec(`CREATE TABLE drug_log_drugs (id INTEGER PRIMARY KEY, label TEXT NOT NULL, color TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, created_at INTEGER NOT NULL)`);
    fresh
      .prepare(
        `INSERT INTO drug_log_drugs (label, color, created_at) VALUES ('Coffee', '#8a5a3c', 1)`,
      )
      .run();
    bootstrapSchema(fresh);
    expect(listDrugs(fresh).map((d) => d.label)).toEqual(['Coffee']);
  });
});

describe('drugs', () => {
  it('creates at the end of the grid with a normalised label and colour', () => {
    const d = createDrug(db, { label: '  Magic   Shroom ', color: '#ABC' }, NOW);
    expect(d).toMatchObject({
      label: 'Magic Shroom',
      color: '#aabbcc',
      sortOrder: 1,
      createdAt: NOW,
    });
  });

  it.each([
    [{ label: '', color: '#000000' }, 'invalid_label'],
    [{ label: 'x'.repeat(13), color: '#000000' }, 'invalid_label'],
    [{ label: 5, color: '#000000' }, 'invalid_label'],
    [{ label: 'Ok', color: 'green' }, 'invalid_color'],
    [{ label: 'Ok', color: '#12345' }, 'invalid_color'],
  ])('rejects %o', (input, code) => {
    expect(codeOf(() => createDrug(db, input, NOW))).toBe(code);
  });

  it('updates only the fields given', () => {
    const d = updateDrug(db, weed().id, { color: '#2f6fb5', sortOrder: 4 }, NOW)!;
    expect(d).toMatchObject({ label: 'Weed', color: '#2f6fb5', sortOrder: 4 });
  });

  it('archives (keeping history and the first archive time) and unarchives', () => {
    tap();
    const id = weed().id;
    expect(updateDrug(db, id, { archived: true }, NOW)!.archivedAt).toBe(NOW);
    expect(updateDrug(db, id, { archived: true }, NOW + 5)!.archivedAt).toBe(NOW);
    expect(getDrug(db, id)!.eventCount).toBe(1);
    expect(listEvents(db)).toHaveLength(1);
    expect(updateDrug(db, id, { archived: false }, NOW)!.archivedAt).toBeNull();
  });

  it('rejects a non-boolean archived and a non-integer sortOrder', () => {
    expect(codeOf(() => updateDrug(db, weed().id, { archived: 'yes' }, NOW))).toBe(
      'invalid_archived',
    );
    expect(codeOf(() => updateDrug(db, weed().id, { sortOrder: 1.5 }, NOW))).toBe(
      'invalid_sort_order',
    );
  });

  it('returns null updating an unknown drug', () => {
    expect(updateDrug(db, 999, { label: 'x' }, NOW)).toBeNull();
  });

  it('delete cascades to the drug’s events and leaves other drugs’ alone', () => {
    const other = createDrug(db, { label: 'Beer', color: '#d99a00' }, NOW);
    tap({ clientId: 'a' });
    tap({ clientId: 'b' });
    tap({ clientId: 'c', drugId: other.id });
    expect(weed().eventCount).toBe(2);
    expect(deleteDrug(db, weed().id)).toBe(true);
    expect(listEvents(db).map((e) => e.clientId)).toEqual(['c']);
    expect(deleteDrug(db, 999)).toBe(false);
  });
});

describe('events', () => {
  it('is idempotent on clientId — a replayed tap is not logged twice', () => {
    const first = tap();
    const replay = tap({ recordedAt: NOW - 1000 });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.event.recordedAt).toBe(NOW);
    expect(listEvents(db)).toHaveLength(1);
  });

  it('accepts a tap a little ahead (clock drift) but not more than 5 minutes', () => {
    expect(tap({ clientId: 'a', recordedAt: NOW + 60_000 }).created).toBe(true);
    expect(codeOf(() => tap({ clientId: 'b', recordedAt: NOW + 6 * 60_000 }))).toBe(
      'invalid_recorded_at',
    );
  });

  it.each([
    [{ clientId: '' }, 'invalid_client_id'],
    [{ drugId: 999 }, 'unknown_drug'],
    [{ drugId: 'weed' }, 'invalid_drug'],
    [{ recordedAt: 'now' }, 'invalid_recorded_at'],
  ])('rejects %o', (bad, code) => {
    expect(codeOf(() => tap(bad))).toBe(code);
  });

  it('logs against an archived drug (a tap queued before the archive still syncs)', () => {
    updateDrug(db, weed().id, { archived: true }, NOW);
    expect(tap().created).toBe(true);
  });

  it('re-times and re-assigns an event', () => {
    const other = createDrug(db, { label: 'Beer', color: '#d99a00' }, NOW);
    const { event } = tap();
    const updated = updateEvent(
      db,
      event.id,
      { recordedAt: NOW - 3_600_000, drugId: other.id },
      NOW + 1,
    )!;
    expect(updated).toMatchObject({
      recordedAt: NOW - 3_600_000,
      drugId: other.id,
      updatedAt: NOW + 1,
    });
    expect(codeOf(() => updateEvent(db, event.id, { drugId: 999 }, NOW))).toBe('unknown_drug');
    expect(updateEvent(db, 999, { recordedAt: NOW }, NOW)).toBeNull();
  });

  it('deletes an event', () => {
    const { event } = tap();
    expect(deleteEvent(db, event.id)).toBe(true);
    expect(deleteEvent(db, event.id)).toBe(false);
  });
});

describe('listEvents', () => {
  beforeEach(() => {
    const beer = createDrug(db, { label: 'Beer', color: '#d99a00' }, NOW);
    tap({ clientId: 'w1', recordedAt: NOW - 3000 });
    tap({ clientId: 'w2', recordedAt: NOW - 1000 });
    tap({ clientId: 'b1', recordedAt: NOW - 2000, drugId: beer.id });
  });

  it('is newest first', () => {
    expect(listEvents(db).map((e) => e.clientId)).toEqual(['w2', 'b1', 'w1']);
  });

  it('filters by since (inclusive), until (exclusive) and drug', () => {
    expect(listEvents(db, { since: NOW - 2000 }).map((e) => e.clientId)).toEqual(['w2', 'b1']);
    expect(listEvents(db, { until: NOW - 1000 }).map((e) => e.clientId)).toEqual(['b1', 'w1']);
    expect(listEvents(db, { drugId: weed().id }).map((e) => e.clientId)).toEqual(['w2', 'w1']);
  });

  it('honours the limit, clamped to at least one', () => {
    expect(listEvents(db, { limit: 2 })).toHaveLength(2);
    expect(listEvents(db, { limit: 0 })).toHaveLength(1);
  });
});
