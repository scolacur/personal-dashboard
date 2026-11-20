import {
  habitWeekStart,
  isDue,
  nodeDone,
  nodeDue,
  nodeProgress,
  projectHabitDay,
  type HabitCompletion,
  type HabitHistoryNode,
  type HabitItemView,
  type HabitSchedule,
} from '@dashboard/shared';
import type { PendingHabitWrite } from './queue';

/**
 * Client-side derivations for the Log › By Habit calendar (PD-726).
 *
 * The calendar shows one item at a time: a dropdown of active items (in manual tree order) then an
 * "Archived" group; a grid of habit-week rows; and per-cell state (done / due / extra / set-derived).
 * All of it is pure and lives here so it is unit-testable without the DOM, the way `tree.ts` is for
 * Today. Streak + completion-rate stats come straight from the shared functions (PD-722 / PD-723).
 *
 * Writes never go through here: a cell toggle is an idempotent set-state message on the one shared
 * outbox owned by `HabitTracker.svelte` (PROJECT.md §4, D-093). This module only reads completions
 * and folds the outbox's still-pending writes over them, so an unsynced toggle does not visually
 * revert (`buildDaySets`).
 */

export interface ItemOption {
  item: HabitItemView;
  /** Nesting depth for indentation in the dropdown (0 at the top level). */
  depth: number;
  /** True when the item has children — a set. */
  isSet: boolean;
}

/** Active items in manual tree order (sets above their children), plus archived items as a flat group. */
export function buildItemOptions(items: HabitItemView[]): { active: ItemOption[]; archived: HabitItemView[] } {
  const active = items.filter((i) => i.archivedAt === null);
  const childrenOf = new Map<number | null, HabitItemView[]>();
  for (const it of active) {
    const list = childrenOf.get(it.parentId) ?? [];
    list.push(it);
    childrenOf.set(it.parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const out: ItemOption[] = [];
  const walk = (parentId: number | null, depth: number): void => {
    for (const it of childrenOf.get(parentId) ?? []) {
      const kids = childrenOf.get(it.id) ?? [];
      out.push({ item: it, depth, isSet: kids.length > 0 });
      walk(it.id, depth + 1);
    }
  };
  walk(null, 0);

  const archived = items
    .filter((i) => i.archivedAt !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return { active: out, archived };
}

/** Group every schedule row by its item id (the input to the Today/By Habit derivations). */
export function groupSchedulesByItem(schedules: HabitSchedule[]): Map<number, HabitSchedule[]> {
  const map = new Map<number, HabitSchedule[]>();
  for (const s of schedules) {
    const list = map.get(s.itemId) ?? [];
    list.push(s);
    map.set(s.itemId, list);
  }
  return map;
}

/** Every id in the subtree rooted at `rootId` (including it), over all items (archived included). */
export function subtreeItemIds(items: HabitItemView[], rootId: number): Set<number> {
  const childrenOf = new Map<number | null, number[]>();
  for (const it of items) {
    const list = childrenOf.get(it.parentId) ?? [];
    list.push(it.id);
    childrenOf.set(it.parentId, list);
  }
  const out = new Set<number>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    for (const child of childrenOf.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** True when `itemId` has at least one child — a set (derived, like the Today tree). */
export function isSetItem(items: HabitItemView[], itemId: number): boolean {
  return items.some((i) => i.parentId === itemId);
}

/**
 * The completion-day set per item id, from the loaded completions with the outbox's still-pending
 * writes folded over them (last write wins per `(item, day)`, exactly what the server will reach).
 * Only `itemIds` are tracked; other items' completions and all metric writes are ignored.
 */
export function buildDaySets(
  completions: HabitCompletion[],
  itemIds: Set<number>,
  pending: PendingHabitWrite[],
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const id of itemIds) map.set(id, new Set<string>());
  for (const c of completions) {
    if (itemIds.has(c.itemId)) map.get(c.itemId)?.add(c.day);
  }
  for (const p of pending) {
    if (p.kind !== 'completion' || !itemIds.has(p.itemId)) continue;
    const set = map.get(p.itemId);
    if (!set) continue;
    if (p.done) set.add(p.day);
    else set.delete(p.day);
  }
  return map;
}

/** Build a {@link HabitHistoryNode} for `rootId`'s subtree — the input to the set derivations. */
export function buildHistoryNode(
  items: HabitItemView[],
  rootId: number,
  schedulesByItem: Map<number, HabitSchedule[]>,
  daySets: Map<number, Set<string>>,
): HabitHistoryNode {
  const childrenOf = new Map<number, HabitItemView[]>();
  for (const it of items) {
    if (it.parentId === null) continue;
    const list = childrenOf.get(it.parentId) ?? [];
    list.push(it);
    childrenOf.set(it.parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const byId = new Map<number, HabitItemView>(items.map((i) => [i.id, i]));
  const build = (id: number): HabitHistoryNode => {
    const it = byId.get(id);
    return {
      kind: it?.kind ?? 'habit',
      children: (childrenOf.get(id) ?? []).map((k) => build(k.id)),
      schedules: schedulesByItem.get(id) ?? [],
      completionDays: daySets.get(id) ?? new Set<string>(),
    };
  };
  return build(rootId);
}

export type CellState = 'done' | 'due' | 'notdue' | 'extra' | 'partial' | 'future';

/** A leaf habit's cell on `day`: done+due, extra (done but not due), due (open), not-due, or future. */
export function leafCellState(
  schedules: HabitSchedule[],
  daySet: Set<string>,
  day: string,
  today: string,
): CellState {
  if (day > today) return 'future';
  const done = daySet.has(day);
  const due = isDue(schedules, day);
  if (done) return due ? 'done' : 'extra';
  return due ? 'due' : 'notdue';
}

/** A set's derived cell on `day`: done, partial (some due children done), due (open), not-due, future. */
export function setCellState(node: HabitHistoryNode, day: string, today: string): CellState {
  if (day > today) return 'future';
  const dayNode = projectHabitDay(node, day);
  if (!nodeDue(dayNode)) return 'notdue';
  if (nodeDone(dayNode)) return 'done';
  return nodeProgress(dayNode).done > 0 ? 'partial' : 'due';
}

/** Number of habit weeks from the week containing `fromDay` to the week containing `toDay`, inclusive. */
export function weekSpanCount(fromDay: string, toDay: string): number {
  const toMs = Date.parse(`${habitWeekStart(toDay)}T00:00:00Z`);
  const fromMs = Date.parse(`${habitWeekStart(fromDay)}T00:00:00Z`);
  if (toMs < fromMs) return 1;
  return Math.round((toMs - fromMs) / (7 * 86_400_000)) + 1;
}
