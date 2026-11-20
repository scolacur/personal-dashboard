import { describe, it, expect } from 'vitest';
import type { HabitCompletion, HabitItemView, HabitSchedule } from '@dashboard/shared';
import {
  buildDaySets,
  buildHistoryNode,
  buildItemOptions,
  isSetItem,
  leafCellState,
  setCellState,
  subtreeItemIds,
  weekSpanCount,
} from './by-habit';
import type { PendingHabitWrite } from './queue';

/**
 * Client derivations for the By Habit calendar (PD-726): the dropdown order, the per-item day-sets
 * (with pending outbox writes folded in), and per-cell state. Set streak/rate stats are the shared
 * functions, tested in the server suite (`habits-stats.spec.ts`).
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

const MWF = 1 | 4 | 16; // Mon, Wed, Fri
function daysOfWeek(itemId: number, effectiveFromDay: string, daysMask: number): HabitSchedule {
  return { id: nextId++, itemId, effectiveFromDay, kind: 'days_of_week', daysMask, perWeekN: null };
}

describe('buildItemOptions', () => {
  it('lists active items in tree order with depth and set-ness, then archived flat', () => {
    const set = item('Vitamins', null, { sortOrder: 0 });
    const a = item('D3', set.id, { sortOrder: 0 });
    const b = item('Zinc', set.id, { sortOrder: 1 });
    const solo = item('Gym', null, { sortOrder: 1 });
    const gone = item('Old habit', null, { sortOrder: 2, archivedAt: 123 });

    const { active, archived } = buildItemOptions([b, gone, set, a, solo]);
    expect(active.map((o) => [o.item.name, o.depth, o.isSet])).toEqual([
      ['Vitamins', 0, true],
      ['D3', 1, false],
      ['Zinc', 1, false],
      ['Gym', 0, false],
    ]);
    expect(archived.map((i) => i.name)).toEqual(['Old habit']);
  });
});

describe('subtreeItemIds / isSetItem', () => {
  it('collects the whole subtree, including archived descendants', () => {
    const set = item('S', null);
    const a = item('a', set.id);
    const nested = item('n', set.id, { archivedAt: 5 });
    const deep = item('d', nested.id, { archivedAt: 5 });
    const items = [set, a, nested, deep];
    expect([...subtreeItemIds(items, set.id)].sort((x, y) => x - y)).toEqual(
      [set.id, a.id, nested.id, deep.id].sort((x, y) => x - y),
    );
    expect(isSetItem(items, set.id)).toBe(true);
    expect(isSetItem(items, a.id)).toBe(false);
  });
});

describe('buildDaySets', () => {
  it('folds pending completion writes over the loaded completions (last write wins)', () => {
    const leaf = item('Read', null);
    const completions: HabitCompletion[] = [
      { itemId: leaf.id, day: '2026-11-10', completedAt: 1 },
      { itemId: leaf.id, day: '2026-11-11', completedAt: 1 },
      { itemId: 999, day: '2026-11-10', completedAt: 1 }, // another item, ignored
    ];
    const pending: PendingHabitWrite[] = [
      { kind: 'completion', itemId: leaf.id, day: '2026-11-11', done: false }, // undo an unsynced untick
      { kind: 'completion', itemId: leaf.id, day: '2026-11-12', done: true }, // unsynced tick
      { kind: 'metric', itemId: leaf.id, day: '2026-11-13', value: '1' }, // not a completion, ignored
    ];
    const sets = buildDaySets(completions, new Set([leaf.id]), pending);
    expect([...(sets.get(leaf.id) ?? [])].sort()).toEqual(['2026-11-10', '2026-11-12']);
  });
});

describe('leafCellState', () => {
  const sched = [daysOfWeek(1, '2026-01-01', MWF)];
  it('classifies done / extra / due / not-due / future', () => {
    const done = new Set(['2026-11-16', '2026-11-17']); // Mon (due), Tue (not due)
    expect(leafCellState(sched, done, '2026-11-16', '2026-11-20')).toBe('done'); // done + due
    expect(leafCellState(sched, done, '2026-11-17', '2026-11-20')).toBe('extra'); // done, not due
    expect(leafCellState(sched, done, '2026-11-18', '2026-11-20')).toBe('due'); // Wed due, not done
    expect(leafCellState(sched, done, '2026-11-19', '2026-11-20')).toBe('notdue'); // Thu not due
    expect(leafCellState(sched, done, '2026-11-21', '2026-11-20')).toBe('future');
  });
});

describe('setCellState', () => {
  it('derives done / partial / due / not-due from the subtree', () => {
    const set = item('S', null);
    const a = item('a', set.id);
    const b = item('b', set.id);
    const node = buildHistoryNode(
      [set, a, b],
      set.id,
      new Map(),
      new Map([
        [a.id, new Set(['2026-11-16'])],
        [b.id, new Set(['2026-11-16', '2026-11-18'])],
      ]),
    );
    // Both leaves daily ⇒ set due every day. 11-16 both done ⇒ done; 11-18 only b ⇒ partial.
    expect(setCellState(node, '2026-11-16', '2026-11-20')).toBe('done');
    expect(setCellState(node, '2026-11-18', '2026-11-20')).toBe('partial');
    expect(setCellState(node, '2026-11-17', '2026-11-20')).toBe('due'); // neither done
    expect(setCellState(node, '2026-11-25', '2026-11-20')).toBe('future');
  });
});

describe('weekSpanCount', () => {
  it('counts inclusive habit weeks between two days', () => {
    expect(weekSpanCount('2026-11-16', '2026-11-16')).toBe(1);
    expect(weekSpanCount('2026-11-02', '2026-11-20')).toBe(3); // weeks 11-02, 11-09, 11-16
    expect(weekSpanCount('2026-12-01', '2026-11-20')).toBe(1); // from after to: clamps to 1
  });
});
