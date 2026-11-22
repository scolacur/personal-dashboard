import {
  isDue,
  perWeekProgress,
  type HabitCompletion,
  type HabitItemView,
  type HabitSchedule,
} from '@dashboard/shared';

/**
 * The count behind the Today "Yesterday: N habits unchecked" banner (T889, spec §3 Today).
 *
 * Pure and DOM-free so it is unit-testable (and so the grouping of the raw schedule / completion
 * rows into per-item maps stays out of the Svelte component, where a mutable `Map`/`Set` would trip
 * the `prefer-svelte-reactivity` lint). It counts **due leaf habits** that went unchecked yesterday,
 * and nothing else:
 *   - metrics are never counted (they are never due);
 *   - sets are not counted (only their leaves are) — a set is any item with a habit child;
 *   - archived items are not counted;
 *   - a habit not *due* yesterday is not counted (days-of-week items off their masked weekdays);
 *   - a per-week habit whose weekly target was already met that week is treated as checked, so a
 *     "Gym 3×/week" done earlier in the week does not nag on a rest day.
 *
 * Each item is judged by the schedule in force on `yesterday` (via the shared `isDue` /
 * `perWeekProgress`), so history is never rewritten. `completions` need only cover the habit week
 * containing yesterday — enough for a per-week target.
 */
export function uncheckedYesterdayCount(
  items: HabitItemView[],
  schedules: HabitSchedule[],
  completions: HabitCompletion[],
  yesterday: string,
): number {
  const schedulesByItem = new Map<number, HabitSchedule[]>();
  for (const s of schedules) {
    const list = schedulesByItem.get(s.itemId) ?? [];
    list.push(s);
    schedulesByItem.set(s.itemId, list);
  }

  const daysByItem = new Map<number, Set<string>>();
  for (const c of completions) {
    const days = daysByItem.get(c.itemId) ?? new Set<string>();
    days.add(c.day);
    daysByItem.set(c.itemId, days);
  }

  // A "set" is any item with at least one *habit* child; metric children do not make a set.
  const hasHabitChildren = new Set<number>();
  for (const it of items) {
    if (it.parentId !== null && it.kind === 'habit') hasHabitChildren.add(it.parentId);
  }

  let count = 0;
  for (const it of items) {
    if (it.archivedAt !== null) continue;
    if (it.kind === 'metric') continue;
    if (hasHabitChildren.has(it.id)) continue; // a set, not a leaf
    const itemSchedules = schedulesByItem.get(it.id) ?? [];
    if (!isDue(itemSchedules, yesterday)) continue;
    const days = daysByItem.get(it.id) ?? new Set<string>();
    if (days.has(yesterday)) continue;
    const perWeek = perWeekProgress(itemSchedules, yesterday, days);
    if (perWeek?.met) continue;
    count += 1;
  }
  return count;
}
