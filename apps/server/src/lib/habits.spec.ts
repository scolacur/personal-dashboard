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
  getTodayView,
  HabitValidationError,
  listItems,
  listSchedules,
  moveItem,
  patchSettings,
  renameItem,
  reorderItems,
  setCompletion,
  setSchedule,
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

describe('schedules (PD-722, D-095)', () => {
  // Nov 16 2026 10:00 EST (15:00 UTC) → habit day 2026-11-16, a Monday.
  const MON = Date.UTC(2026, 10, 16, 15, 0);
  const MWF = 1 | 4 | 16; // Mon, Wed, Fri

  it('inserts a schedule effective today, and a same-day re-edit upserts it', () => {
    const item = createItem(db, { name: 'Gym' });
    const s1 = setSchedule(db, item.id, { kind: 'days_of_week', daysMask: MWF }, MON);
    expect(s1).toMatchObject({
      itemId: item.id,
      effectiveFromDay: '2026-11-16',
      kind: 'days_of_week',
      daysMask: MWF,
      perWeekN: null,
    });

    setSchedule(db, item.id, { kind: 'per_week', perWeekN: 3 }, MON);
    const rows = listSchedules(db, item.id);
    expect(rows).toHaveLength(1); // same day → one row, last write wins
    expect(rows[0]).toMatchObject({ kind: 'per_week', perWeekN: 3, daysMask: null });
  });

  it('validates input and returns null for a missing item', () => {
    const item = createItem(db, { name: 'Gym' });
    expect(() => setSchedule(db, item.id, { kind: 'nope' })).toThrow(HabitValidationError);
    expect(() => setSchedule(db, item.id, { kind: 'days_of_week', daysMask: 0 })).toThrow(HabitValidationError);
    expect(() => setSchedule(db, item.id, { kind: 'days_of_week', daysMask: 200 })).toThrow(HabitValidationError);
    expect(() => setSchedule(db, item.id, { kind: 'per_week', perWeekN: 0 })).toThrow(HabitValidationError);
    expect(() => setSchedule(db, item.id, { kind: 'per_week', perWeekN: 8 })).toThrow(HabitValidationError);
    expect(setSchedule(db, 9999, { kind: 'days_of_week', daysMask: MWF })).toBeNull();
  });
});

describe('getTodayView (PD-722, D-095)', () => {
  const MWF = 1 | 4 | 16;
  const MON = Date.UTC(2026, 10, 16, 15, 0); // 2026-11-16
  const TUE = Date.UTC(2026, 10, 17, 15, 0); // 2026-11-17
  const FRI = Date.UTC(2026, 10, 20, 15, 0); // 2026-11-20

  it('marks a Mon/Wed/Fri habit due on Monday but not on Tuesday', () => {
    const item = createItem(db, { name: 'Gym' });
    setSchedule(db, item.id, { kind: 'days_of_week', daysMask: MWF }, MON);

    const findRow = (now: number) => getTodayView(db, now).rows.find((r) => r.item.id === item.id);
    expect(findRow(MON)?.due).toBe(true);
    expect(findRow(TUE)?.due).toBe(false);
  });

  it('reports per-week progress, streak and completedToday', () => {
    const item = createItem(db, { name: 'Run' });
    setSchedule(db, item.id, { kind: 'per_week', perWeekN: 3 }, MON);
    for (const day of ['2026-11-16', '2026-11-18', '2026-11-20']) {
      setCompletion(db, { itemId: item.id, day, done: true });
    }

    const row = getTodayView(db, FRI).rows.find((r) => r.item.id === item.id);
    expect(row?.perWeek).toEqual({ count: 3, target: 3, met: true });
    expect(row?.due).toBe(true);
    expect(row?.completedToday).toBe(true);
    expect(row?.streak.current).toBe(1); // the current week, met
  });

  it('excludes archived items and defaults an unscheduled habit to daily (due)', () => {
    const daily = createItem(db, { name: 'Floss' });
    const gone = createItem(db, { name: 'Old' });
    archiveItem(db, gone.id, true);

    const rows = getTodayView(db, TUE).rows;
    expect(rows.map((r) => r.item.id)).toEqual([daily.id]);
    expect(rows[0].due).toBe(true); // no schedule → daily
    expect(rows[0].schedule).toBeNull();
  });
});

describe('sets — moveItem + derived Today rows (PD-723)', () => {
  const TUE = Date.UTC(2026, 10, 17, 15, 0); // 2026-11-17, a daily-due day

  /** Morning Routine → Vitamins → (Vitamin D, B12), all daily. Returns the created ids. */
  function morningRoutine() {
    const mr = createItem(db, { name: 'Morning Routine' });
    const vitamins = createItem(db, { name: 'Vitamins' });
    const vitaminD = createItem(db, { name: 'Vitamin D' });
    const b12 = createItem(db, { name: 'B12' });
    moveItem(db, vitamins.id, mr.id, [vitamins.id]);
    moveItem(db, vitaminD.id, vitamins.id, [vitaminD.id]);
    moveItem(db, b12.id, vitamins.id, [vitaminD.id, b12.id]);
    return { mr: mr.id, vitamins: vitamins.id, vitaminD: vitaminD.id, b12: b12.id };
  }

  it('nests items and reports a set row with derived progress', () => {
    const { mr, vitamins } = morningRoutine();
    const rows = getTodayView(db, TUE).rows;
    const mrRow = rows.find((r) => r.item.id === mr)!;
    const vitRow = rows.find((r) => r.item.id === vitamins)!;

    expect(mrRow.isSet).toBe(true);
    expect(mrRow.progress).toEqual({ done: 0, total: 1 }); // Vitamins counted as one child
    expect(vitRow.isSet).toBe(true);
    expect(vitRow.item.parentId).toBe(mr);
  });

  it('ticking both leaves makes Vitamins and Morning Routine done (nested set as one child)', () => {
    const { mr, vitamins, vitaminD, b12 } = morningRoutine();
    setCompletion(db, { itemId: vitaminD, day: '2026-11-17', done: true });
    setCompletion(db, { itemId: b12, day: '2026-11-17', done: true });

    const rows = getTodayView(db, TUE).rows;
    expect(rows.find((r) => r.item.id === vitamins)!.completedToday).toBe(true);
    expect(rows.find((r) => r.item.id === mr)!.completedToday).toBe(true);
    expect(rows.find((r) => r.item.id === mr)!.progress).toEqual({ done: 1, total: 1 });
  });

  it('when B12 is not due, Vitamins is done once Vitamin D alone is done', () => {
    const { vitamins, vitaminD, b12 } = morningRoutine();
    // B12 due only Mon/Wed/Fri → not due on Tue 2026-11-17.
    setSchedule(db, b12, { kind: 'days_of_week', daysMask: 1 | 4 | 16 }, TUE);
    setCompletion(db, { itemId: vitaminD, day: '2026-11-17', done: true });

    const vitRow = getTodayView(db, TUE).rows.find((r) => r.item.id === vitamins)!;
    expect(vitRow.due).toBe(true);
    expect(vitRow.completedToday).toBe(true);
    expect(vitRow.progress).toEqual({ done: 1, total: 1 });
  });

  it('archiving a set archives its whole subtree', () => {
    const { mr, vitamins, vitaminD, b12 } = morningRoutine();
    archiveItem(db, mr, true);
    const all = listItems(db, { includeArchived: true });
    for (const id of [mr, vitamins, vitaminD, b12]) {
      expect(all.find((i) => i.id === id)!.archivedAt).not.toBeNull();
    }
    expect(getTodayView(db, TUE).rows).toHaveLength(0);
  });

  it('rejects a cycle (nesting a set under its own descendant)', () => {
    const { mr, vitamins } = morningRoutine();
    expect(() => moveItem(db, mr, vitamins, [mr])).toThrow(HabitValidationError);
    expect(() => moveItem(db, mr, mr, [mr])).toThrow(HabitValidationError);
  });

  it('moves an item back out to the top level', () => {
    const { mr, vitamins } = morningRoutine();
    moveItem(db, vitamins, null, [mr, vitamins]);
    expect(listItems(db).find((i) => i.id === vitamins)!.parentId).toBeNull();
  });

  it('returns null for an unknown item', () => {
    expect(moveItem(db, 9999, null, undefined)).toBeNull();
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
