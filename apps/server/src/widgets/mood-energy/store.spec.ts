import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapHabitsSchema, patchSettings } from '../../lib/habits';
import { bootstrapSchema } from './schema';
import {
  createTag,
  deleteEntry,
  getEntry,
  getEntryByDay,
  hideTag,
  listEntries,
  listTags,
  saveEntry,
  updateEntry,
  ValidationError,
} from './store';

let db: Database.Database;
/** 2026-11-20 12:00 in New York (the habit settings' default timezone). */
const NOON = Date.UTC(2026, 10, 20, 17, 0);
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapHabitsSchema(db);
  bootstrapSchema(db);
});

function save(overrides: Record<string, unknown> = {}, now = NOON) {
  return saveEntry(db, { clientId: 'c1', recordedAt: now, mood: 4, energy: 2, tags: [], ...overrides }, now);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).code;
  }
}

describe('schema', () => {
  it('seeds the default feeling tags once, in order, and a reboot does not un-hide one', () => {
    expect(listTags(db).map((t) => t.name)).toEqual(['calm', 'anxious', 'irritable', 'focused', 'sad', 'grateful']);
    hideTag(db, listTags(db)[0].id, NOON);
    bootstrapSchema(db);
    expect(listTags(db).map((t) => t.name)).toEqual(['anxious', 'irritable', 'focused', 'sad', 'grateful']);
  });
});

describe('saveEntry', () => {
  it('creates the day from recordedAt, with tags sorted and the note trimmed', () => {
    const { entry, created } = save({ tags: ['focused', 'calm'], note: '  good day  ' });
    expect(created).toBe(true);
    expect(entry).toMatchObject({
      day: '2026-11-20',
      recordedAt: NOON,
      mood: 4,
      energy: 2,
      tags: ['calm', 'focused'],
      note: 'good day',
    });
  });

  it('upserts by day: a second save for the same day updates the one row', () => {
    const first = save({ tags: ['calm'], note: 'morning' });
    const later = NOON + 3 * HOUR;
    const second = save({ clientId: 'c2', recordedAt: later, mood: 2, energy: 5, tags: ['sad'], note: null }, later);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry).toMatchObject({ mood: 2, energy: 5, tags: ['sad'], note: null, recordedAt: later });
    expect(second.entry.createdAt).toBe(NOON);
    expect(listEntries(db)).toHaveLength(1);
  });

  it('is idempotent on clientId, even replaying an older save after a newer one', () => {
    save();
    save({ clientId: 'c2', mood: 1 });
    const replay = save({ clientId: 'c1', mood: 5 });
    expect(replay.created).toBe(false);
    expect(replay.entry.mood).toBe(1);
    expect(listEntries(db)).toHaveLength(1);
  });

  it('puts a save before the day boundary on the previous day (01:30 → yesterday)', () => {
    const at0130 = Date.UTC(2026, 10, 21, 6, 30); // 01:30 New York, Nov 21
    expect(save({ recordedAt: at0130 }, at0130).entry.day).toBe('2026-11-20');
    const at0430 = Date.UTC(2026, 10, 21, 9, 30); // 04:30, past the default 04:00 boundary
    expect(save({ clientId: 'c2', recordedAt: at0430 }, at0430).entry.day).toBe('2026-11-21');
  });

  it('follows the Habit Tracker settings for boundary and timezone', () => {
    patchSettings(db, { dayBoundaryMinutes: 0, timezone: 'Europe/London' });
    const at0130 = Date.UTC(2026, 10, 21, 1, 30); // 01:30 London
    expect(save({ recordedAt: at0130 }, at0130).entry.day).toBe('2026-11-21');
  });

  it('uses an explicit day for a backfill, and upserts that day', () => {
    const back = save({ day: '2026-11-17' });
    expect(back.entry.day).toBe('2026-11-17');
    expect(save({ clientId: 'c2', day: '2026-11-17', mood: 1 }).entry.id).toBe(back.entry.id);
    expect(getEntryByDay(db, '2026-11-17')?.mood).toBe(1);
    expect(getEntryByDay(db, '2026-11-20')).toBeNull();
  });

  it('creates unknown tags and un-hides hidden ones, so an offline custom tag still syncs', () => {
    const calm = listTags(db).find((t) => t.name === 'calm')!;
    hideTag(db, calm.id, NOON);
    expect(save({ tags: ['Calm', '  Over   Joyed '] }).entry.tags).toEqual(['calm', 'over joyed']);
    expect(listTags(db).map((t) => t.name)).toEqual(expect.arrayContaining(['calm', 'over joyed']));
  });

  it.each([
    [{ mood: 0 }, 'invalid_mood'],
    [{ mood: 6 }, 'invalid_mood'],
    [{ mood: 2.5 }, 'invalid_mood'],
    [{ energy: '3' }, 'invalid_energy'],
    [{ energy: undefined }, 'invalid_energy'],
    [{ recordedAt: NOON + 10 * 60 * 1000 }, 'invalid_recorded_at'],
    [{ recordedAt: 'now' }, 'invalid_recorded_at'],
    [{ clientId: '' }, 'invalid_client_id'],
    [{ day: '2026-11-21' }, 'invalid_day'],
    [{ day: '2026-02-30' }, 'invalid_day'],
    [{ day: '20-11-2026' }, 'invalid_day'],
    [{ note: 'x'.repeat(2001) }, 'invalid_note'],
    [{ note: 5 }, 'invalid_note'],
    [{ tags: [''] }, 'invalid_tag'],
    [{ tags: ['x'.repeat(33)] }, 'invalid_tag'],
    [{ tags: 'calm' }, 'invalid_tags'],
  ])('rejects %o', (bad, code) => {
    expect(codeOf(() => save(bad))).toBe(code);
    expect(listEntries(db)).toHaveLength(0);
  });

  it('allows a recordedAt slightly ahead, for phone clock drift', () => {
    expect(save({ recordedAt: NOON + 60_000 }).created).toBe(true);
  });
});

describe('listEntries', () => {
  it('lists newest day first, within an inclusive since/until range', () => {
    ['2026-11-15', '2026-11-18', '2026-11-20', '2026-11-16'].forEach((day, i) => save({ clientId: `c${i}`, day }));
    expect(listEntries(db).map((e) => e.day)).toEqual(['2026-11-20', '2026-11-18', '2026-11-16', '2026-11-15']);
    expect(listEntries(db, { since: '2026-11-16', until: '2026-11-18' }).map((e) => e.day)).toEqual([
      '2026-11-18',
      '2026-11-16',
    ]);
    expect(listEntries(db, { limit: 1 }).map((e) => e.day)).toEqual(['2026-11-20']);
  });
});

describe('updateEntry / deleteEntry', () => {
  it('patches only the fields given and stamps recordedAt with the save time', () => {
    const { entry } = save({ tags: ['calm'], note: 'n' });
    const later = NOON + HOUR;
    const updated = updateEntry(db, entry.id, { energy: 5, tags: ['sad', 'anxious'] }, later)!;
    expect(updated).toMatchObject({ mood: 4, energy: 5, tags: ['anxious', 'sad'], note: 'n', recordedAt: later });
    expect(codeOf(() => updateEntry(db, entry.id, { mood: 9 }, later))).toBe('invalid_mood');
    expect(updateEntry(db, 999, { mood: 2 }, later)).toBeNull();
  });

  it('deletes the entry and its client ids, so the day is empty again', () => {
    const { entry } = save({ tags: ['calm'] });
    expect(deleteEntry(db, entry.id)).toBe(true);
    expect(getEntry(db, entry.id)).toBeNull();
    expect(deleteEntry(db, entry.id)).toBe(false);
    expect(listTags(db).some((t) => t.name === 'calm')).toBe(true);
  });
});

describe('tags', () => {
  it('createTag normalises, and un-hides an existing hidden tag instead of duplicating it', () => {
    const sad = listTags(db).find((t) => t.name === 'sad')!;
    hideTag(db, sad.id, NOON);
    expect(createTag(db, '  SAD ', NOON)).toMatchObject({ id: sad.id, hiddenAt: null });
    expect(codeOf(() => createTag(db, '   ', NOON))).toBe('invalid_tag');
    expect(hideTag(db, 999, NOON)).toBe(false);
  });
});
