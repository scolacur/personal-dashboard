import {
  nodeDone,
  nodeDue,
  nodeProgress,
  type HabitDayNode,
  type HabitItemView,
  type HabitTodayRow,
  type SetProgress,
  type StreakResult,
} from '@dashboard/shared';

/**
 * Today's habit tree (PD-723). The server returns flat {@link HabitTodayRow}s carrying `parentId`;
 * the client rebuilds the tree so it can render nesting, chips and collapse, and recompute a set's
 * done/progress **optimistically** as leaves are ticked.
 *
 * Set due/done/progress are derived with the shared pure functions (`nodeDue`/`nodeDone`/
 * `nodeProgress`) so the client and the server (D-095) agree. A set's *streak* is taken from the
 * server row — it needs full completion history the client does not hold — and only refreshes on the
 * next Today pull, which is fine (a streak figure is never on the optimistic path).
 */
export interface HabitTreeNode {
  item: HabitItemView;
  row: HabitTodayRow;
  isSet: boolean;
  children: HabitTreeNode[];
  /** Derived (set) or server (leaf): is this on Today? */
  due: boolean;
  /** Leaf: optimistic completion. Set: derived (every due child done). */
  done: boolean;
  /** Non-null only for a set. */
  progress: SetProgress | null;
  streak: StreakResult;
  /** 0 at the top level, incremented per nesting level. */
  depth: number;
}

/**
 * Build the forest of top-level nodes from flat rows, deriving each set's due/done/progress from the
 * (optimistic) `completed` leaf set. Sibling order follows the server's row order within each parent.
 */
export function buildHabitTree(
  rows: HabitTodayRow[],
  completed: ReadonlySet<number>,
): HabitTreeNode[] {
  const childrenByParent = new Map<number | null, HabitTodayRow[]>();
  for (const r of rows) {
    const list = childrenByParent.get(r.item.parentId) ?? [];
    list.push(r);
    childrenByParent.set(r.item.parentId, list);
  }

  const build = (row: HabitTodayRow, depth: number): { tree: HabitTreeNode; day: HabitDayNode } => {
    const kids = (childrenByParent.get(row.item.id) ?? []).map((c) => build(c, depth + 1));
    const day: HabitDayNode = {
      kind: row.item.kind,
      children: kids.map((k) => k.day),
      due: row.due,
      done: completed.has(row.item.id),
    };
    const isSet = kids.length > 0;
    const tree: HabitTreeNode = {
      item: row.item,
      row,
      isSet,
      children: kids.map((k) => k.tree),
      due: isSet ? nodeDue(day) : row.due,
      done: isSet ? nodeDone(day) : completed.has(row.item.id),
      progress: isSet ? nodeProgress(day) : null,
      streak: row.streak,
      depth,
    };
    return { tree, day };
  };

  return (childrenByParent.get(null) ?? []).map((r) => build(r, 0).tree);
}

/** Every due leaf habit under `node` (itself if it is a due leaf). Metrics and not-due leaves excluded. */
export function dueLeaves(node: HabitTreeNode): HabitTreeNode[] {
  if (node.item.kind === 'metric') return [];
  if (node.isSet) return node.children.flatMap(dueLeaves);
  return node.due ? [node] : [];
}

/** The top-level sets, in order — the source of the Today filter chips. */
export function topLevelSets(tree: HabitTreeNode[]): HabitTreeNode[] {
  return tree.filter((n) => n.isSet);
}

/** Flatten a forest depth-first into an in-order list (used by the Habits manage tab's drag list). */
export function flattenTree(nodes: HabitTreeNode[]): HabitTreeNode[] {
  const out: HabitTreeNode[] = [];
  const walk = (n: HabitTreeNode): void => {
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
