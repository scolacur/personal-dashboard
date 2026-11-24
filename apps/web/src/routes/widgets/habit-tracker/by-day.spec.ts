import { describe, it, expect } from 'vitest';
import type {
  HabitChoiceOption,
  HabitItemView,
  HabitMetricValue,
  HabitSchedule,
} from '@dashboard/shared';
import { choiceValue } from '@dashboard/shared';
import { buildDaySets, groupSchedulesByItem } from './by-habit';
import {
  applyCompletionWrite,
  buildDayRows,
  buildMetricValueMap,
  formatMetricCell,
  habitDaysBetween,
  monthSpans,
  setDayShortcut,
  weekdayLetter,
} from './by-day';
import type { PendingHabitWrite } from './queue';

/**
 * Client derivations for the By Day grid (PD-725): row order, the loaded day span, folded metric
 * values, metric-cell text, and the set-cell tap shortcut. Per-cell habit/set state is `by-habit`'s
 * `leafCellState` / `setCellState`, already covered by `by-habit.spec.ts`.
 */

let nextId = 1;
function item(name: string, parentId: number | null, opts: Partial<HabitItemView> = {}): HabitItemView {
  return {
    id: nextId++,
    parentId,
    kind: 'habit',
    metricType: null,
    name,
    sortOrder: 0,
    archivedAt: null,
    createdAt: 0,
    completionCount: 0,
    ...opts,
  };
}

const MWF = 1 | 4 | 16; // Mon, Wed, Fri (Monday-indexed bits)
function daysOfWeek(itemId: number, effectiveFromDay: string, daysMask: number): HabitSchedule {
  return { id: nextId++, itemId, effectiveFromDay, kind: 'days_of_week', daysMask, perWeekN: null };
}

describe('buildDayRows', () => {
  it('lists the habit tree (sets above children) then metrics below, archived excluded', () => {
    const set = item('Vitamins', null, { sortOrder: 0 });
    const d3 = item('D3', set.id, { sortOrder: 0 });
    const zinc = item('Zinc', set.id, { sortOrder: 1 });
    const gym = item('Gym', null, { sortOrder: 1 });
    const drinks = item('Drinks', null, { sortOrder: 2, kind: 'metric', metricType: 'number' });
    const gone = item('Old', null, { sortOrder: 3, archivedAt: 123 });

    const rows = buildDayRows([zinc, drinks, gone, set, d3, gym]);
    expect(rows.map((r) => [r.item.name, r.depth, r.isSet, r.isMetric])).toEqual([
      ['Vitamins', 0, true, false],
      ['D3', 1, false, false],
      ['Zinc', 1, false, false],
      ['Gym', 0, false, false],
      ['Drinks', 0, false, true],
    ]);
  });
});

describe('habitDaysBetween', () => {
  it('returns the inclusive day span oldest first, and [] when reversed', () => {
    expect(habitDaysBetween('2026-11-18', '2026-11-20')).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    expect(habitDaysBetween('2026-11-20', '2026-11-20')).toEqual(['2026-11-20']);
    expect(habitDaysBetween('2026-11-21', '2026-11-20')).toEqual([]);
  });
});

describe('buildMetricValueMap', () => {
  it('folds pending metric writes over the loaded values (last write wins, null clears)', () => {
    const values: HabitMetricValue[] = [
      { itemId: 1, day: '2026-11-18', value: '2', updatedAt: 1 },
      { itemId: 1, day: '2026-11-19', value: '3', updatedAt: 1 },
    ];
    const pending: PendingHabitWrite[] = [
      { kind: 'metric', itemId: 1, day: '2026-11-19', value: null }, // clears an older value
      { kind: 'metric', itemId: 1, day: '2026-11-20', value: '1' }, // a new unsynced value
      { kind: 'completion', itemId: 1, day: '2026-11-20', done: true }, // ignored
    ];
    const map = buildMetricValueMap(values, pending);
    expect(map.get(1)?.get('2026-11-18')).toBe('2');
    expect(map.get(1)?.get('2026-11-19')).toBeNull();
    expect(map.get(1)?.get('2026-11-20')).toBe('1');
  });
});

describe('formatMetricCell', () => {
  const options: HabitChoiceOption[] = [
    { id: 10, itemId: 1, label: 'weed', sortOrder: 0, archivedAt: null },
    { id: 11, itemId: 1, label: 'mdma', sortOrder: 1, archivedAt: null },
  ];
  it('shows time / number as-is, choice ids as labels, and null as blank', () => {
    expect(formatMetricCell('08:42', 'time', [])).toBe('08:42');
    expect(formatMetricCell('0', 'number', [])).toBe('0');
    expect(formatMetricCell(choiceValue([10, 11]), 'choice', options)).toBe('weed, mdma');
    expect(formatMetricCell(choiceValue([11]), 'choice', options)).toBe('mdma');
    expect(formatMetricCell(null, 'number', [])).toBe('');
  });
});

describe('setDayShortcut', () => {
  // A set of two Mon/Wed/Fri leaves; '2026-11-16' is a Monday (both due).
  const set = item('S', null);
  const a = item('a', set.id);
  const b = item('b', set.id);
  const items = [set, a, b];
  const schedulesByItem = groupSchedulesByItem([
    daysOfWeek(a.id, '2026-01-01', MWF),
    daysOfWeek(b.id, '2026-01-01', MWF),
  ]);

  it('completes the outstanding due leaves when the set is partly done', () => {
    const daySets = buildDaySets([{ itemId: a.id, day: '2026-11-16', completedAt: 1 }], new Set([a.id, b.id]), []);
    const writes = setDayShortcut(items, schedulesByItem, daySets, set.id, '2026-11-16');
    expect(writes).toEqual([{ leafId: b.id, done: true }]); // a already done, b completed
  });

  it('unticks every due leaf when the set is fully done', () => {
    const daySets = buildDaySets(
      [
        { itemId: a.id, day: '2026-11-16', completedAt: 1 },
        { itemId: b.id, day: '2026-11-16', completedAt: 1 },
      ],
      new Set([a.id, b.id]),
      [],
    );
    const writes = setDayShortcut(items, schedulesByItem, daySets, set.id, '2026-11-16').sort(
      (x, y) => x.leafId - y.leafId,
    );
    expect(writes).toEqual([
      { leafId: a.id, done: false },
      { leafId: b.id, done: false },
    ]);
  });

  it('returns no writes on a day the set has no due leaf', () => {
    const daySets = buildDaySets([], new Set([a.id, b.id]), []);
    // '2026-11-17' is a Tuesday — neither leaf is due.
    expect(setDayShortcut(items, schedulesByItem, daySets, set.id, '2026-11-17')).toEqual([]);
  });
});

describe('applyCompletionWrite', () => {
  const base = [
    { itemId: 1, day: '2026-11-20', completedAt: 1 },
    { itemId: 2, day: '2026-11-20', completedAt: 2 },
  ];

  it('adds a completion on tick and removes it on untick (PD-972)', () => {
    const ticked = applyCompletionWrite(base, 1, '2026-11-21', true, 99);
    expect(ticked).toContainEqual({ itemId: 1, day: '2026-11-21', completedAt: 99 });
    expect(applyCompletionWrite(ticked, 1, '2026-11-21', false)).toEqual(base);
  });

  it('is idempotent: re-ticking never duplicates, unticking an absent day is a no-op', () => {
    const twice = applyCompletionWrite(base, 1, '2026-11-20', true, 5);
    expect(twice.filter((c) => c.itemId === 1 && c.day === '2026-11-20')).toHaveLength(1);
    expect(applyCompletionWrite(base, 3, '2026-11-20', false)).toEqual(base);
  });
});

describe('weekdayLetter', () => {
  it('maps a habit day to its Monday-first letter, R for Thursday', () => {
    // 2026-11-23 is a Monday.
    const week = ['23', '24', '25', '26', '27', '28', '29'].map((d) => weekdayLetter(`2026-11-${d}`));
    expect(week).toEqual(['M', 'T', 'W', 'R', 'F', 'Sa', 'Su']);
  });
});

describe('monthSpans', () => {
  it('groups consecutive days into month spans across a seam and a year boundary', () => {
    const days = habitDaysBetween('2025-12-30', '2026-02-02');
    expect(monthSpans(days)).toEqual([
      { key: '2025-12', label: 'December 2025', start: 0, length: 2 },
      { key: '2026-01', label: 'January 2026', start: 2, length: 31 },
      { key: '2026-02', label: 'February 2026', start: 33, length: 2 },
    ]);
  });

  it('returns no spans for no days', () => {
    expect(monthSpans([])).toEqual([]);
  });
});
