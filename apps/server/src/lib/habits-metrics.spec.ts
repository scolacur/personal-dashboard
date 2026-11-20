import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { choiceValue } from '@dashboard/shared';
import {
  archiveChoiceOption,
  bootstrapHabitsSchema,
  createChoiceOption,
  createItem,
  deleteChoiceOption,
  getMetricValues,
  getTodayView,
  HabitValidationError,
  listChoiceOptions,
  moveItem,
  renameChoiceOption,
  setCompletion,
  setMetricType,
  setMetricValue,
} from './habits';

/**
 * Metrics: typed daily values + choice options (PD-724). These exercise the store directly, the way
 * `habits.spec.ts` does, since the pure value validators live in `@dashboard/shared`
 * (`habits-metric-format.spec.ts` covers those) and the store adds the DB-backed rules — type locking,
 * option membership, and the not-logged/zero distinction.
 */

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapHabitsSchema(db);
});

function metric(name: string, metricType: 'time' | 'number' | 'choice') {
  return createItem(db, { name, kind: 'metric', metricType });
}

describe('createItem — metrics', () => {
  it('creates a metric with its type', () => {
    const m = metric('Drinks', 'number');
    expect(m.kind).toBe('metric');
    expect(m.metricType).toBe('number');
  });

  it('rejects a metric with no / invalid type', () => {
    expect(() => createItem(db, { name: 'X', kind: 'metric' })).toThrow(HabitValidationError);
    expect(() => createItem(db, { name: 'X', kind: 'metric', metricType: 'bogus' })).toThrow(
      HabitValidationError,
    );
  });
});

describe('setMetricValue — number: not-logged vs a logged 0', () => {
  const DAY = '2026-11-20';

  it('distinguishes a logged 0 from not-logged, and clearing from 0', () => {
    const drinks = metric('Drinks', 'number');

    // Not logged: no row at all.
    expect(getMetricValues(db, DAY, DAY)).toHaveLength(0);

    // Logged 0: a real value.
    const zero = setMetricValue(db, { itemId: drinks.id, day: DAY, value: '0' });
    expect(zero).toEqual({ value: { itemId: drinks.id, day: DAY, value: '0', updatedAt: expect.any(Number) } });
    expect(getMetricValues(db, DAY, DAY)).toHaveLength(1);

    // Cleared back to not-logged: the row is gone, distinct from the '0' above.
    const cleared = setMetricValue(db, { itemId: drinks.id, day: DAY, value: null });
    expect(cleared).toEqual({ value: null });
    expect(getMetricValues(db, DAY, DAY)).toHaveLength(0);
  });

  it('is idempotent set-state (last write wins)', () => {
    const drinks = metric('Drinks', 'number');
    setMetricValue(db, { itemId: drinks.id, day: DAY, value: '2' });
    setMetricValue(db, { itemId: drinks.id, day: DAY, value: '3' });
    expect(getMetricValues(db, DAY, DAY)[0].value).toBe('3');
  });

  it('rejects a non-numeric value', () => {
    const drinks = metric('Drinks', 'number');
    expect(() => setMetricValue(db, { itemId: drinks.id, day: DAY, value: 'lots' })).toThrow(
      HabitValidationError,
    );
  });
});

describe('setMetricValue — time', () => {
  it('accepts HH:MM and rejects garbage', () => {
    const mr = metric('Morning Routine Done By', 'time');
    expect(setMetricValue(db, { itemId: mr.id, day: '2026-11-20', value: '08:42' })).toMatchObject({
      value: { value: '08:42' },
    });
    expect(() => setMetricValue(db, { itemId: mr.id, day: '2026-11-20', value: '25:00' })).toThrow(
      HabitValidationError,
    );
  });
});

describe('setMetricValue — choice: several options on one day', () => {
  const DAY = '2026-11-20';

  it('accepts several options and rejects an unknown option id', () => {
    const drugs = metric('Drugs', 'choice');
    const weed = createChoiceOption(db, drugs.id, 'weed')!;
    const mdma = createChoiceOption(db, drugs.id, 'mdma')!;

    const value = choiceValue([weed.id, mdma.id]);
    const saved = setMetricValue(db, { itemId: drugs.id, day: DAY, value });
    expect(saved).toMatchObject({ value: { value } });

    // An option id that is not this metric's is refused.
    expect(() => setMetricValue(db, { itemId: drugs.id, day: DAY, value: choiceValue([9999]) })).toThrow(
      HabitValidationError,
    );
  });
});

describe("setMetricType — a metric's type cannot change once it has a value", () => {
  const DAY = '2026-11-20';

  it('allows a change before any value and refuses it after', () => {
    const m = metric('Drinks', 'number');

    // Before any value: a change is fine.
    expect(setMetricType(db, m.id, 'time')!.metricType).toBe('time');

    // Log a value, then the type is locked.
    setMetricValue(db, { itemId: m.id, day: DAY, value: '07:00' });
    expect(() => setMetricType(db, m.id, 'number')).toThrow(HabitValidationError);
    try {
      setMetricType(db, m.id, 'number');
    } catch (e) {
      expect((e as HabitValidationError).code).toBe('metric_type_locked');
    }

    // Re-asserting the SAME type is a no-op, not a refusal.
    expect(setMetricType(db, m.id, 'time')!.metricType).toBe('time');
  });
});

describe('choice options CRUD', () => {
  it('creates, renames, archives and deletes, listing active-only by default', () => {
    const drugs = metric('Drugs', 'choice');
    const a = createChoiceOption(db, drugs.id, 'weed')!;
    const b = createChoiceOption(db, drugs.id, 'mdma')!;

    expect(listChoiceOptions(db, drugs.id).map((o) => o.label)).toEqual(['weed', 'mdma']);

    renameChoiceOption(db, a.id, 'cannabis');
    expect(listChoiceOptions(db, drugs.id)[0].label).toBe('cannabis');

    archiveChoiceOption(db, b.id, true);
    expect(listChoiceOptions(db, drugs.id).map((o) => o.label)).toEqual(['cannabis']);
    expect(listChoiceOptions(db, drugs.id, { includeArchived: true })).toHaveLength(2);

    expect(deleteChoiceOption(db, a.id)).toBe(true);
    expect(listChoiceOptions(db, drugs.id, { includeArchived: true }).map((o) => o.id)).toEqual([b.id]);
  });

  it('refuses options on a non-choice metric', () => {
    const drinks = metric('Drinks', 'number');
    expect(() => createChoiceOption(db, drinks.id, 'x')).toThrow(HabitValidationError);
  });
});

describe('getTodayView — metrics section', () => {
  const NOW = Date.parse('2026-11-20T15:00:00Z'); // a Friday afternoon, well past the 04:00 boundary

  it('carries active metrics with today value and (for choice) options, never as habit rows', () => {
    const drinks = metric('Drinks', 'number');
    const drugs = metric('Drugs', 'choice');
    createChoiceOption(db, drugs.id, 'weed');
    const day = getTodayView(db, NOW).day;
    setMetricValue(db, { itemId: drinks.id, day, value: '0' });

    const view = getTodayView(db, NOW);
    // Metrics are not habit rows.
    expect(view.rows.some((r) => r.item.kind === 'metric')).toBe(false);
    expect(view.metrics.map((m) => m.item.name).sort()).toEqual(['Drinks', 'Drugs']);

    const drinksRow = view.metrics.find((m) => m.item.id === drinks.id)!;
    expect(drinksRow.value).toBe('0'); // a logged zero, not null
    expect(drinksRow.options).toEqual([]);

    const drugsRow = view.metrics.find((m) => m.item.id === drugs.id)!;
    expect(drugsRow.value).toBeNull(); // not logged
    expect(drugsRow.options.map((o) => o.label)).toEqual(['weed']);
  });

  it('a metric inside a set never affects the set progress or done state', () => {
    // Morning Routine → [ Floss (habit), Morning Routine Done By (time metric) ].
    const mr = createItem(db, { name: 'Morning Routine' });
    const floss = createItem(db, { name: 'Floss' });
    const mrDoneBy = metric('Morning Routine Done By', 'time');
    moveItem(db, floss.id, mr.id, [floss.id]);
    moveItem(db, mrDoneBy.id, mr.id, [floss.id, mrDoneBy.id]);

    const day = getTodayView(db, NOW).day;

    // With only Floss done, the set is done and progress is 1/1 — the metric doesn't count.
    setCompletion(db, { itemId: floss.id, day, done: true });
    let mrRow = getTodayView(db, NOW).rows.find((r) => r.item.id === mr.id)!;
    expect(mrRow.completedToday).toBe(true);
    expect(mrRow.progress).toEqual({ done: 1, total: 1 });

    // Logging the metric changes nothing about the set.
    setMetricValue(db, { itemId: mrDoneBy.id, day, value: '08:42' });
    mrRow = getTodayView(db, NOW).rows.find((r) => r.item.id === mr.id)!;
    expect(mrRow.completedToday).toBe(true);
    expect(mrRow.progress).toEqual({ done: 1, total: 1 });
  });
});
