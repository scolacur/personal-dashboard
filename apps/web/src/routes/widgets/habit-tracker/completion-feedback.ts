import { dueLeaves, type HabitTreeNode } from './tree';

/**
 * Pure logic behind the Today completion-feedback layers (T889, spec §3 "Completion feedback").
 *
 * The visual layers themselves are CSS/Svelte transitions in `TodayList.svelte` /
 * `HabitTracker.svelte`; everything that needs *deciding* — when the whole day is done, whether the
 * once-per-day burst is allowed to play, which streak lengths earn a flourish — lives here so it is
 * DOM-free and unit-testable. The burst's "at most once per habit day, no replay after untick +
 * re-tick" rule is the one the ticket asks to be tested at the logic level.
 */

/** Streak lengths that earn a small flourish on the row (spec §3, Today). */
export const STREAK_MILESTONES: readonly number[] = [7, 30, 100, 365];

/** Whether a streak length is a milestone worth a flourish. */
export function isStreakMilestone(streak: number): boolean {
  return STREAK_MILESTONES.includes(streak);
}

/**
 * Whether every due leaf habit on Today is done — the trigger for the whole-day burst.
 *
 * A leaf counts as done when it is ticked today **or** its per-week target is already met (the same
 * "done" a per-week row shows). Metrics and sets are never leaves here (`dueLeaves` excludes them).
 * An empty day (nothing due) is **not** complete — there is nothing to celebrate.
 */
export function isDayComplete(tree: HabitTreeNode[]): boolean {
  const leaves = tree.flatMap(dueLeaves);
  if (leaves.length === 0) return false;
  return leaves.every((l) => l.done || (l.row.perWeek?.met ?? false));
}

/**
 * Whether the whole-day burst should fire right now. It fires only when the day is complete *and* it
 * has not already fired for this habit day. The caller persists `lastFiredDay` (the last day a burst
 * played), so unticking and re-ticking — which flips `complete` false then true again on the same
 * `day` — never replays it, and a page reload after the day was already celebrated stays silent.
 * A new habit day (a different `day`) is eligible again.
 */
export function shouldFireDayBurst(
  day: string,
  complete: boolean,
  lastFiredDay: string | null,
): boolean {
  return complete && day !== lastFiredDay;
}
