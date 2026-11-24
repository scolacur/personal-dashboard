import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { sleepNightInstants } from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import {
  ConflictError,
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
// 2026-11-24 12:00 America/New_York (EST, UTC−5).
const NOW = Date.UTC(2026, 10, 24, 17, 0);
const HOUR = 3_600_000;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
});

/** 23:00 → 07:00 waking on `wakeDate`. */
function night(wakeDate = '2026-11-24') {
  return sleepNightInstants(wakeDate, 23 * 60, 7 * 60);
}

function entry(overrides: Record<string, unknown> = {}) {
  return createEntry(db, { clientId: 'c1', ...night(), rested: 3, tags: [], ...overrides }, NOW);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ValidationError).code;
  }
  return undefined;
}

describe('schema', () => {
  it('seeds the default tags once, in order, and re-booting does not un-hide one', () => {
    expect(listTags(db).map((t) => t.name)).toEqual(['Magnesium', 'Ashwagandha', 'Melatonin']);
    hideTag(db, listTags(db)[0].id, NOW);
    bootstrapSchema(db);
    expect(listTags(db).map((t) => t.name)).toEqual(['Ashwagandha', 'Melatonin']);
  });
});

describe('createEntry', () => {
  it('stores times, rested, counted tags and trimmed notes, keyed by the local wake date', () => {
    const { entry: e, created } = entry({
      rested: 4,
      tags: [
        { name: 'Melatonin', count: 1 },
        { name: 'Magnesium', count: 2 },
      ],
      notes: '  flying dream  ',
    });
    expect(created).toBe(true);
    expect(e).toMatchObject({
      wakeDate: '2026-11-24',
      rested: 4,
      notes: 'flying dream',
      tags: [
        { name: 'Magnesium', count: 2 },
        { name: 'Melatonin', count: 1 },
      ],
    });
    expect(e.wakeAt - e.sleepAt).toBe(8 * HOUR);
  });

  it('derives the wake date in New York time, not UTC', () => {
    // 21:00 EST on the 23rd is already the 24th in UTC.
    const { entry: e } = entry(sleepNightInstants('2026-11-23', 13 * 60, 21 * 60));
    expect(e.wakeDate).toBe('2026-11-23');
  });

  it('upserts by wake date: a second save of the same night updates it (200, not a new row)', () => {
    const first = entry({ rested: 2, tags: [{ name: 'Magnesium', count: 1 }], notes: 'a' });
    const second = entry({ clientId: 'c2', rested: 5, tags: [{ name: 'Melatonin', count: 3 }], notes: null });
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry).toMatchObject({ rested: 5, notes: null, tags: [{ name: 'Melatonin', count: 3 }] });
    expect(listEntries(db)).toHaveLength(1);
  });

  it('is idempotent on clientId — a replay does not re-apply over a later edit', () => {
    const first = entry({ rested: 2 });
    updateEntry(db, first.entry.id, { rested: 5 }, NOW);
    const replay = entry({ rested: 2 });
    expect(replay.created).toBe(false);
    expect(replay.entry.rested).toBe(5);
    // Replaying an upserting client id is a no-op too.
    entry({ clientId: 'c2', rested: 1 });
    updateEntry(db, first.entry.id, { rested: 4 }, NOW);
    expect(entry({ clientId: 'c2', rested: 1 }).entry.rested).toBe(4);
  });

  it('round-trips tag counts, and creates unknown tags / un-hides hidden ones case-insensitively', () => {
    const mag = listTags(db).find((t) => t.name === 'Magnesium')!;
    hideTag(db, mag.id, NOW);
    const { entry: e } = entry({
      tags: [
        { name: 'magnesium', count: 20 },
        { name: '  Valerian   Root ', count: 1 },
      ],
    });
    expect(e.tags).toEqual([
      { name: 'Magnesium', count: 20 },
      { name: 'Valerian Root', count: 1 },
    ]);
    expect(listTags(db).map((t) => t.name)).toEqual(['Magnesium', 'Ashwagandha', 'Melatonin', 'Valerian Root']);
  });

  it.each([
    [{ rested: 0 }, 'invalid_rested'],
    [{ rested: 6 }, 'invalid_rested'],
    [{ rested: 2.5 }, 'invalid_rested'],
    [{ sleepAt: night().wakeAt }, 'invalid_times'],
    [{ sleepAt: night().wakeAt - 25 * HOUR }, 'invalid_duration'],
    [{ ...sleepNightInstants('2026-11-25', 23 * 60, 7 * 60) }, 'invalid_wake_at'],
    [{ wakeAt: 'soon' }, 'invalid_wake_at'],
    [{ clientId: '' }, 'invalid_client_id'],
    [{ notes: 'x'.repeat(4001) }, 'invalid_notes'],
    [{ tags: [{ name: '', count: 1 }] }, 'invalid_tag'],
    [{ tags: [{ name: 'x'.repeat(33), count: 1 }] }, 'invalid_tag'],
    [{ tags: [{ name: 'Magnesium', count: 0 }] }, 'invalid_count'],
    [{ tags: [{ name: 'Magnesium', count: 21 }] }, 'invalid_count'],
    [{ tags: [{ name: 'Magnesium', count: 1.5 }] }, 'invalid_count'],
    [{ tags: ['Magnesium'] }, 'invalid_tags'],
    [{ tags: 'Magnesium' }, 'invalid_tags'],
  ])('rejects %o', (bad, code) => {
    expect(() => entry(bad)).toThrow(ValidationError);
    expect(codeOf(() => entry(bad))).toBe(code);
  });

  it('allows a wake time slightly ahead, for phone clock drift', () => {
    expect(entry({ wakeAt: NOW + 60_000, sleepAt: NOW - 7 * HOUR }).created).toBe(true);
  });
});

describe('updateEntry / deleteEntry', () => {
  it('changes only the fields given, and replaces tags wholesale', () => {
    const { entry: e } = entry({ tags: [{ name: 'Magnesium', count: 1 }], notes: 'n' });
    const updated = updateEntry(db, e.id, { rested: 5, tags: [{ name: 'Ashwagandha', count: 2 }] }, NOW + 1)!;
    expect(updated).toMatchObject({
      rested: 5,
      tags: [{ name: 'Ashwagandha', count: 2 }],
      notes: 'n',
      sleepAt: e.sleepAt,
      updatedAt: NOW + 1,
    });
  });

  it('moves a night to a new wake date, but not onto a taken one', () => {
    const { entry: a } = entry();
    entry({ clientId: 'c2', ...night('2026-11-22') });
    const moved = updateEntry(db, a.id, night('2026-11-23'), NOW)!;
    expect(moved.wakeDate).toBe('2026-11-23');
    expect(() => updateEntry(db, a.id, night('2026-11-22'), NOW)).toThrow(ConflictError);
  });

  it('validates the merged times', () => {
    const { entry: e } = entry();
    expect(codeOf(() => updateEntry(db, e.id, { sleepAt: e.wakeAt + 1 }, NOW))).toBe('invalid_times');
  });

  it('returns null for an unknown entry', () => {
    expect(updateEntry(db, 999, { rested: 1 }, NOW)).toBeNull();
  });

  it('deletes the night and its tag links, but never the tag', () => {
    const { entry: e } = entry({ tags: [{ name: 'Magnesium', count: 1 }] });
    expect(deleteEntry(db, e.id)).toBe(true);
    expect(getEntry(db, e.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sleep_journal_entry_tags').get()).toEqual({ n: 0 });
    expect(listTags(db).some((t) => t.name === 'Magnesium')).toBe(true);
  });
});

describe('tags', () => {
  it('hiding keeps the tag on past nights', () => {
    const { entry: e } = entry({ tags: [{ name: 'Melatonin', count: 1 }] });
    hideTag(db, listTags(db).find((t) => t.name === 'Melatonin')!.id, NOW);
    expect(listTags(db).map((t) => t.name)).not.toContain('Melatonin');
    expect(getEntry(db, e.id)!.tags).toEqual([{ name: 'Melatonin', count: 1 }]);
  });

  it('createTag is case-insensitive, returns the existing tag and un-hides it', () => {
    const a = createTag(db, 'Glycine', NOW);
    hideTag(db, a.id, NOW);
    const b = createTag(db, 'glycine', NOW);
    expect(b).toMatchObject({ id: a.id, name: 'Glycine', hiddenAt: null });
  });

  it('hideTag reports a missing tag', () => {
    expect(hideTag(db, 999, NOW)).toBe(false);
  });
});

describe('listEntries', () => {
  it('is newest wake date first, so a backfilled night slots in by date', () => {
    entry({ clientId: 'a', ...night('2026-11-24') });
    entry({ clientId: 'b', ...night('2026-11-20') });
    entry({ clientId: 'c', ...night('2026-11-22') });
    expect(listEntries(db).map((e) => e.wakeDate)).toEqual(['2026-11-24', '2026-11-22', '2026-11-20']);
  });

  it('`since` is an inclusive wake date and lifts the default cap', () => {
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 10, 24) - i * 86_400_000).toISOString().slice(0, 10);
      entry({ clientId: `r${i}`, ...night(d) });
    }
    expect(listEntries(db)).toHaveLength(50);
    const got = listEntries(db, { since: '2026-10-01' });
    expect(got).toHaveLength(55);
    expect(got.at(-1)!.wakeDate).toBe('2026-10-01');
  });
});
