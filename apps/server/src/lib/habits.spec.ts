import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { habitDay, type HabitSettings } from '@dashboard/shared';
import {
  archiveItem,
  bootstrapHabitsSchema,
  createItem,
  deleteItem,
  getCompletions,
  getSettings,
  HabitValidationError,
  listItems,
  patchSettings,
  renameItem,
  reorderItems,
  setCompletion,
} from './habits';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapHabitsSchema(db);
});

describe('bootstrapHabitsSchema', () => {
  it('is idempotent', () => {
    expect(() => bootstrapHabitsSchema(db)).not.toThrow();
  });

  it('seeds one settings row with the defaults', () => {
    expect(getSettings(db)).toEqual({ dayBoundaryMinutes: 240, timezone: 'America/New_York' });
  });

  it('does not overwrite settings on a later boot', () => {
    patchSettings(db, { dayBoundaryMinutes: 300 });
    bootstrapHabitsSchema(db);
    expect(getSettings(db).dayBoundaryMinutes).toBe(300);
  });
});

describe('items', () => {
  it('creates a habit at the end of the list, active by default', () => {
    const a = createItem(db, { name: 'Floss' });
    const b = createItem(db, { name: 'Gym' });
    expect(a.kind).toBe('habit');
    expect(a.archivedAt).toBeNull();
    expect(a.completionCount).toBe(0);
    expect(listItems(db).map((i) => i.name)).toEqual(['Floss', 'Gym']);
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
  });

  it('trims the name and rejects an empty one', () => {
    expect(createItem(db, { name: '  Read  ' }).name).toBe('Read');
    expect(() => createItem(db, { name: '   ' })).toThrow(HabitValidationError);
    expect(() => createItem(db, { name: 42 })).toThrow(HabitValidationError);
  });

  it('renames without touching history', () => {
    const item = createItem(db, { name: 'Gym' });
    setCompletion(db, { itemId: item.id, day: '2026-11-16', done: true });
    const renamed = renameItem(db, item.id, 'Workout');
    expect(renamed?.name).toBe('Workout');
    expect(renamed?.completionCount).toBe(1);
    expect(renameItem(db, 9999, 'Nope')).toBeNull();
  });

  it('reorders to the given id order', () => {
    const a = createItem(db, { name: 'A' });
    const b = createItem(db, { name: 'B' });
    const c = createItem(db, { name: 'C' });
    reorderItems(db, [c.id, a.id, b.id]);
    expect(listItems(db).map((i) => i.name)).toEqual(['C', 'A', 'B']);
  });

  it('archiving removes an item from the active list but keeps completions', () => {
    const item = createItem(db, { name: 'Gym' });
    setCompletion(db, { itemId: item.id, day: '2026-11-16', done: true });
    archiveItem(db, item.id, true);

    expect(listItems(db)).toHaveLength(0);
    const [archived] = listItems(db, { includeArchived: true });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.completionCount).toBe(1);

    archiveItem(db, item.id, false);
    expect(listItems(db)).toHaveLength(1);
    expect(listItems(db)[0].archivedAt).toBeNull();
  });

  it('deletes an item and reports the completion count erased', () => {
    const item = createItem(db, { name: 'Gym' });
    setCompletion(db, { itemId: item.id, day: '2026-11-16', done: true });
    setCompletion(db, { itemId: item.id, day: '2026-11-15', done: true });

    expect(deleteItem(db, item.id)).toEqual({ completionCount: 2 });
    expect(listItems(db, { includeArchived: true })).toHaveLength(0);
    // Cascade removed the completions too.
    expect(getCompletions(db, '2026-11-01', '2026-11-30')).toHaveLength(0);
    expect(deleteItem(db, item.id)).toBeNull();
  });
});

describe('completions', () => {
  it('is set-state and idempotent — the last write wins', () => {
    const item = createItem(db, { name: 'Gym' });

    const first = setCompletion(db, { itemId: item.id, day: '2026-11-16', done: true }, 1000);
    expect(first).toEqual({ completion: { itemId: item.id, day: '2026-11-16', completedAt: 1000 } });

    // Replay with a later timestamp: still one row, last write wins.
    const replay = setCompletion(db, { itemId: item.id, day: '2026-11-16', done: true }, 2000);
    expect(replay).toEqual({ completion: { itemId: item.id, day: '2026-11-16', completedAt: 2000 } });
    expect(getCompletions(db, '2026-11-16', '2026-11-16')).toHaveLength(1);

    // Untick, then re-untick: both harmless.
    expect(setCompletion(db, { itemId: item.id, day: '2026-11-16', done: false })).toEqual({
      completion: null,
    });
    expect(setCompletion(db, { itemId: item.id, day: '2026-11-16', done: false })).toEqual({
      completion: null,
    });
    expect(getCompletions(db, '2026-11-16', '2026-11-16')).toHaveLength(0);
  });

  it('404-signals an unknown item and validates input', () => {
    expect(setCompletion(db, { itemId: 9999, day: '2026-11-16', done: true })).toEqual({ notFound: true });
    const item = createItem(db, { name: 'Gym' });
    expect(() => setCompletion(db, { itemId: item.id, day: 'nope', done: true })).toThrow(HabitValidationError);
    expect(() => setCompletion(db, { itemId: item.id, day: '2026-11-16', done: 'yes' })).toThrow(
      HabitValidationError,
    );
  });

  it('reads completions within an inclusive day range', () => {
    const item = createItem(db, { name: 'Gym' });
    for (const day of ['2026-11-14', '2026-11-15', '2026-11-16']) {
      setCompletion(db, { itemId: item.id, day, done: true });
    }
    expect(getCompletions(db, '2026-11-15', '2026-11-16').map((c) => c.day)).toEqual([
      '2026-11-15',
      '2026-11-16',
    ]);
  });
});

describe('settings', () => {
  it('patches each field independently and validates them', () => {
    expect(patchSettings(db, { dayBoundaryMinutes: 0 }).dayBoundaryMinutes).toBe(0);
    expect(patchSettings(db, { timezone: 'Europe/London' }).timezone).toBe('Europe/London');
    expect(() => patchSettings(db, { dayBoundaryMinutes: 1440 })).toThrow(HabitValidationError);
    expect(() => patchSettings(db, { dayBoundaryMinutes: 12.5 })).toThrow(HabitValidationError);
    expect(() => patchSettings(db, { timezone: 'Mars/Phobos' })).toThrow(HabitValidationError);
  });
});

describe('habitDay (the shared boundary function)', () => {
  const ny: HabitSettings = { dayBoundaryMinutes: 240, timezone: 'America/New_York' };

  // Helper: an instant for a given wall-clock time in a UTC offset, expressed as a Date.UTC.
  it('puts a tick just before the 04:00 boundary on the previous date', () => {
    // 2026-11-16 03:59 EST (UTC-5) → 08:59Z
    expect(habitDay(Date.UTC(2026, 10, 16, 8, 59), ny)).toBe('2026-11-15');
    // 2026-11-16 04:00 EST → 09:00Z
    expect(habitDay(Date.UTC(2026, 10, 16, 9, 0), ny)).toBe('2026-11-16');
    // 03:30 home time (EST) → 08:30Z, well before the boundary
    expect(habitDay(Date.UTC(2026, 10, 16, 8, 30), ny)).toBe('2026-11-15');
  });

  it('is correct across a DST change (the offset is applied, not a fixed one)', () => {
    // Winter (EST, UTC-5): 04:00 local = 09:00Z → today; 03:59 local = 08:59Z → yesterday.
    expect(habitDay(Date.UTC(2026, 0, 1, 9, 0), ny)).toBe('2026-01-01');
    expect(habitDay(Date.UTC(2026, 0, 1, 8, 59), ny)).toBe('2025-12-31');
    // Summer (EDT, UTC-4): 04:00 local = 08:00Z → today; 03:59 local = 07:59Z → yesterday.
    expect(habitDay(Date.UTC(2026, 6, 1, 8, 0), ny)).toBe('2026-07-01');
    expect(habitDay(Date.UTC(2026, 6, 1, 7, 59), ny)).toBe('2026-06-30');
  });

  it('respects a custom boundary and timezone', () => {
    const midnight: HabitSettings = { dayBoundaryMinutes: 0, timezone: 'UTC' };
    expect(habitDay(Date.UTC(2026, 10, 16, 0, 0), midnight)).toBe('2026-11-16');
    expect(habitDay(Date.UTC(2026, 10, 15, 23, 59), midnight)).toBe('2026-11-15');
  });
});
