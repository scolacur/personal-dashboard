import { describe, it, expect } from 'vitest';
import type { HabitItemView, HabitTodayRow } from '@dashboard/shared';
import { buildHabitTree, dueLeaves, topLevelSets } from './tree';

/**
 * The Today render tree (PD-723): the client rebuilds the tree from flat server rows and recomputes a
 * set's done/progress from the optimistic done-set. These are the client-side derivations that back
 * the tick-all shortcut and the filter chips.
 */

let nextId = 1;
function item(name: string, parentId: number | null): HabitItemView {
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
  };
}

function row(it: HabitItemView, due = true): HabitTodayRow {
  return {
    item: it,
    schedule: null,
    due,
    completedToday: false,
    perWeek: null,
    streak: { current: 0, longest: 0 },
    isSet: false,
    progress: null,
  };
}

describe('buildHabitTree', () => {
  it('nests by parentId and derives set done/progress from the completed set', () => {
    const mr = item('Morning Routine', null);
    const vitamins = item('Vitamins', mr.id);
    const vitaminD = item('Vitamin D', vitamins.id);
    const b12 = item('B12', vitamins.id);
    const floss = item('Floss', mr.id);
    const rows = [mr, vitamins, vitaminD, b12, floss].map((i) => row(i));

    // Nothing done yet.
    let tree = buildHabitTree(rows, new Set());
    expect(tree).toHaveLength(1);
    const mrNode = tree[0];
    expect(mrNode.isSet).toBe(true);
    expect(mrNode.progress).toEqual({ done: 0, total: 2 }); // Vitamins + Floss
    const vitNode = mrNode.children.find((c) => c.item.id === vitamins.id)!;
    expect(vitNode.progress).toEqual({ done: 0, total: 2 });

    // Tick both vitamins → Vitamins done; Morning Routine counts it as one of two children.
    tree = buildHabitTree(rows, new Set([vitaminD.id, b12.id]));
    const vit2 = tree[0].children.find((c) => c.item.id === vitamins.id)!;
    expect(vit2.done).toBe(true);
    expect(tree[0].progress).toEqual({ done: 1, total: 2 });
    expect(tree[0].done).toBe(false); // Floss still outstanding

    // Tick Floss too → the whole set is done.
    tree = buildHabitTree(rows, new Set([vitaminD.id, b12.id, floss.id]));
    expect(tree[0].done).toBe(true);
  });

  it('drops a not-due leaf from a set denominator', () => {
    const vitamins = item('Vitamins', null);
    const vitaminD = item('Vitamin D', vitamins.id);
    const b12 = item('B12', vitamins.id);
    const rows = [row(vitamins), row(vitaminD, true), row(b12, false)]; // B12 not due today
    const tree = buildHabitTree(rows, new Set([vitaminD.id]));
    expect(tree[0].progress).toEqual({ done: 1, total: 1 });
    expect(tree[0].done).toBe(true); // Vitamin D alone completes it
  });
});

describe('dueLeaves + topLevelSets', () => {
  it('collects due leaf descendants for the tick-all shortcut', () => {
    const mr = item('Morning Routine', null);
    const vitamins = item('Vitamins', mr.id);
    const vitaminD = item('Vitamin D', vitamins.id);
    const b12 = item('B12', vitamins.id);
    const rows = [row(mr), row(vitamins), row(vitaminD, true), row(b12, false)];
    const tree = buildHabitTree(rows, new Set());
    expect(dueLeaves(tree[0]).map((n) => n.item.id)).toEqual([vitaminD.id]); // B12 not due
    expect(topLevelSets(tree).map((s) => s.item.id)).toEqual([mr.id]);
  });
});
