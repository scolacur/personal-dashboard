import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import {
  createEntry,
  createTag,
  deleteEntry,
  getEntry,
  hideTag,
  listEntries,
  listTags,
  updateEntry,
  ValidationError,
} from './store';

let db: Database.Database;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
});

function entry(overrides: Record<string, unknown> = {}) {
  return createEntry(db, { clientId: 'c1', recordedAt: NOW, intensity: 4, tags: [], ...overrides }, NOW);
}

describe('schema', () => {
  it('seeds the default tags once, in order, and re-booting does not un-hide one', () => {
    expect(listTags(db).map((t) => t.name)).toEqual(['weed', 'caffeine', 'alcohol']);
    hideTag(db, listTags(db)[0].id, NOW);
    bootstrapSchema(db);
    expect(listTags(db).map((t) => t.name)).toEqual(['caffeine', 'alcohol']);
  });
});

describe('createEntry', () => {
  it('stores value, tags and notes, with notes trimmed', () => {
    const { entry: e, created } = entry({ tags: ['caffeine', 'alcohol'], notes: '  loud after gig  ' });
    expect(created).toBe(true);
    expect(e).toMatchObject({ intensity: 4, recordedAt: NOW, tags: ['alcohol', 'caffeine'], notes: 'loud after gig' });
  });

  it('is idempotent on clientId — a replayed offline entry is not logged twice', () => {
    const first = entry();
    const replay = entry({ intensity: 9 });
    expect(replay.created).toBe(false);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(replay.entry.intensity).toBe(4);
    expect(listEntries(db)).toHaveLength(1);
  });

  it('creates unknown tags and un-hides hidden ones, so an offline custom tag still syncs', () => {
    const weed = listTags(db).find((t) => t.name === 'weed')!;
    hideTag(db, weed.id, NOW);
    const { entry: e } = entry({ tags: ['Weed', '  Loud   Bar '] });
    expect(e.tags).toEqual(['loud bar', 'weed']);
    expect(listTags(db).map((t) => t.name)).toEqual(['weed', 'caffeine', 'alcohol', 'loud bar']);
  });

  it.each([
    [{ intensity: 11 }, 'invalid_intensity'],
    [{ intensity: -1 }, 'invalid_intensity'],
    [{ intensity: 3.5 }, 'invalid_intensity'],
    [{ recordedAt: NOW + 10 * 60 * 1000 }, 'invalid_recorded_at'],
    [{ clientId: '' }, 'invalid_client_id'],
    [{ tags: [''] }, 'invalid_tag'],
    [{ tags: 'weed' }, 'invalid_tags'],
  ])('rejects %o', (bad, code) => {
    expect(() => entry(bad)).toThrow(ValidationError);
    try {
      entry(bad);
    } catch (e) {
      expect((e as ValidationError).code).toBe(code);
    }
  });

  it('allows a recordedAt slightly ahead, for phone clock drift', () => {
    expect(entry({ recordedAt: NOW + 60_000 }).created).toBe(true);
  });
});

describe('updateEntry / deleteEntry', () => {
  it('changes only the fields given, and replaces tags wholesale', () => {
    const { entry: e } = entry({ tags: ['weed'], notes: 'n' });
    const updated = updateEntry(db, e.id, { intensity: 7, tags: ['caffeine'] }, NOW + 1)!;
    expect(updated).toMatchObject({ intensity: 7, tags: ['caffeine'], notes: 'n', recordedAt: NOW, updatedAt: NOW + 1 });
  });

  it('returns null for an unknown entry', () => {
    expect(updateEntry(db, 999, { intensity: 1 }, NOW)).toBeNull();
  });

  it('deletes the entry and its tag links, but never the tag', () => {
    const { entry: e } = entry({ tags: ['weed'] });
    expect(deleteEntry(db, e.id)).toBe(true);
    expect(getEntry(db, e.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tinnitus_tracker_entry_tags').get()).toEqual({ n: 0 });
    expect(listTags(db).some((t) => t.name === 'weed')).toBe(true);
  });
});

describe('tags', () => {
  it('hiding keeps the tag on past entries', () => {
    const { entry: e } = entry({ tags: ['alcohol'] });
    hideTag(db, listTags(db).find((t) => t.name === 'alcohol')!.id, NOW);
    expect(listTags(db).map((t) => t.name)).not.toContain('alcohol');
    expect(getEntry(db, e.id)!.tags).toEqual(['alcohol']);
  });

  it('createTag is case-insensitive and returns the existing tag', () => {
    const a = createTag(db, 'Tinnitus Drops', NOW);
    const b = createTag(db, 'tinnitus drops', NOW);
    expect(b.id).toBe(a.id);
  });

  it('hideTag reports a missing tag', () => {
    expect(hideTag(db, 999, NOW)).toBe(false);
  });
});

describe('listEntries', () => {
  it('is newest-first by recordedAt, so a backdated entry slots in by when it happened', () => {
    entry({ clientId: 'a', recordedAt: NOW });
    entry({ clientId: 'b', recordedAt: NOW - 3_600_000 });
    entry({ clientId: 'c', recordedAt: NOW - 60_000 });
    expect(listEntries(db).map((e) => e.clientId)).toEqual(['a', 'c', 'b']);
  });
});

describe('listEntries since', () => {
  it('returns only entries at or after `since`, past the default 50 cap', () => {
    for (let i = 0; i < 60; i++) entry({ clientId: `r${i}`, recordedAt: NOW - i * 1000 });
    entry({ clientId: 'old', recordedAt: NOW - 10_000_000 });
    const got = listEntries(db, { since: NOW - 59_000 });
    expect(got).toHaveLength(60);
    expect(got.some((e) => e.clientId === 'old')).toBe(false);
  });
});
