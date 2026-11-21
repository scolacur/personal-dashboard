import {
  addHabitDays,
  isDue,
  parseChoiceValue,
  type HabitChoiceOption,
  type HabitItemView,
  type HabitMetricType,
  type HabitMetricValue,
  type HabitSchedule,
} from '@dashboard/shared';
import { subtreeItemIds } from './by-habit';
import type { PendingHabitWrite } from './queue';

/**
 * Client-side derivations for the Log › By Day grid (PD-725, this ticket).
 *
 * By Day lays every active item out as a row (sets above their children, metrics in a section
 * below) and every loaded habit day as the other axis. Like `by-habit.ts`, everything here is pure
 * and DOM-free so it is unit-testable: the row order, the day span of the loaded window, the
 * folded metric values, the per-cell metric text, and the set-cell tap shortcut. Per-cell habit /
 * set state reuses `leafCellState` / `setCellState` from `by-habit.ts` directly.
 *
 * Writes never go through here: a cell tap is an idempotent set-state message on the one shared
 * outbox owned by `HabitTracker.svelte` (PROJECT.md §4, D-093). This module only reads and folds.
 */

/** One row of the By Day grid: an item plus its render hints. */
export interface DayRow {
  item: HabitItemView;
  /** Nesting depth for indentation (0 at the top level; always 0 for a metric). */
  depth: number;
  /** True when the item has habit children — rendered as a derived set cell. */
  isSet: boolean;
  /** True for a `metric` item — rendered as a value cell that opens an editor. */
  isMetric: boolean;
}

/**
 * Active items as grid rows: the habit/set tree in manual order (a set immediately above its
 * children), then every active metric in a section below the habits (PROJECT.md §3, "sets indented
 * above their children, metrics below the habits"). Archived items are excluded.
 */
export function buildDayRows(items: HabitItemView[]): DayRow[] {
  const active = items.filter((i) => i.archivedAt === null);
  const childrenOf = new Map<number | null, HabitItemView[]>();
  for (const it of active) {
    const list = childrenOf.get(it.parentId) ?? [];
    list.push(it);
    childrenOf.set(it.parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const habitRows: DayRow[] = [];
  const metricRows: DayRow[] = [];
  const walk = (parentId: number | null, depth: number): void => {
    for (const it of childrenOf.get(parentId) ?? []) {
      if (it.kind === 'metric') {
        metricRows.push({ item: it, depth: 0, isSet: false, isMetric: true });
        continue;
      }
      const habitKids = (childrenOf.get(it.id) ?? []).filter((k) => k.kind !== 'metric');
      habitRows.push({ item: it, depth, isSet: habitKids.length > 0, isMetric: false });
      walk(it.id, depth + 1);
    }
  };
  walk(null, 0);
  return [...habitRows, ...metricRows];
}

/** The habit days from `from` to `to` inclusive, oldest first. `from > to` yields `[]`. */
export function habitDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addHabitDays(d, 1)) out.push(d);
  return out;
}

/**
 * The logged metric value per `(item, day)`, from the loaded values with the outbox's still-pending
 * metric writes folded over them (last write wins — exactly what the server will reach). A `null`
 * value is a clear (distinct from a missing entry, which is "not logged"); both display blank.
 */
export function buildMetricValueMap(
  values: HabitMetricValue[],
  pending: PendingHabitWrite[],
): Map<number, Map<string, string | null>> {
  const map = new Map<number, Map<string, string | null>>();
  const put = (itemId: number, day: string, value: string | null): void => {
    let byDay = map.get(itemId);
    if (!byDay) {
      byDay = new Map<string, string | null>();
      map.set(itemId, byDay);
    }
    byDay.set(day, value);
  };
  for (const v of values) put(v.itemId, v.day, v.value);
  for (const p of pending) {
    if (p.kind === 'metric') put(p.itemId, p.day, p.value);
  }
  return map;
}

/** The text shown in a metric cell: the time / number as-is, choice ids as their option labels, null → ''. */
export function formatMetricCell(
  value: string | null,
  metricType: HabitMetricType | null,
  options: HabitChoiceOption[],
): string {
  if (value === null) return '';
  if (metricType === 'choice') {
    const ids = parseChoiceValue(value) ?? [];
    return ids
      .map((id) => options.find((o) => o.id === id)?.label)
      .filter((l): l is string => l !== undefined)
      .join(', ');
  }
  return value;
}

/**
 * The completion writes a tap on a set cell should enqueue for `day` — the same shortcut Today's set
 * tap uses (PD-723): if every due leaf descendant is done, untick them all; otherwise complete the
 * ones still outstanding (never clearing what's already done). Each due leaf is judged by the
 * schedule in force on `day`, so a past day honours its own schedule. Returns the minimal set of
 * `(leaf, done)` toggles; an empty array when the set has no due leaf that day.
 */
export function setDayShortcut(
  items: HabitItemView[],
  schedulesByItem: Map<number, HabitSchedule[]>,
  daySets: Map<number, Set<string>>,
  setId: number,
  day: string,
): { leafId: number; done: boolean }[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const hasChildren = new Set<number>();
  for (const it of items) if (it.parentId !== null) hasChildren.add(it.parentId);

  const dueLeaves: number[] = [];
  for (const id of subtreeItemIds(items, setId)) {
    const it = byId.get(id);
    if (!it || it.kind === 'metric' || hasChildren.has(id)) continue; // a leaf habit only
    if (isDue(schedulesByItem.get(id) ?? [], day)) dueLeaves.push(id);
  }
  if (dueLeaves.length === 0) return [];

  const isDone = (id: number): boolean => daySets.get(id)?.has(day) ?? false;
  const target = !dueLeaves.every(isDone);
  return dueLeaves.filter((id) => isDone(id) !== target).map((id) => ({ leafId: id, done: target }));
}
