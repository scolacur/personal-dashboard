import { describe, it, expect } from 'vitest';
import {
  isSetNode,
  nodeDue,
  nodeDone,
  nodeProgress,
  projectHabitDay,
  setStreak,
  type HabitDayNode,
  type HabitHistoryNode,
  type HabitSchedule,
} from '@dashboard/shared';

/**
 * Pure set-derivation logic (PD-723): a set is due/done/progressed/streaked entirely from its
 * subtree, nested to any depth. These live in `@dashboard/shared` and are tested here, the way the
 * schedule logic is (`habits-schedule.spec.ts`), since the shared package has no runner of its own.
 *
 * The anchor week is Mon 2026-11-16 … Sun 2026-11-22. Weekday bits are Monday-indexed.
 */

const DAILY: HabitSchedule[] = []; // no rows → due every day

let nextId = 1;
function daysOfWeek(effectiveFromDay: string, daysMask: number): HabitSchedule[] {
  return [{ id: nextId++, itemId: nextId, effectiveFromDay, kind: 'days_of_week', daysMask, perWeekN: null }];
}

/** A leaf habit day-node. */
function leaf(due: boolean, done: boolean): HabitDayNode {
  return { kind: 'habit', children: [], due, done };
}
/** A set day-node over the given children (its own due/done are ignored — derived). */
function set(...children: HabitDayNode[]): HabitDayNode {
  return { kind: 'habit', children, due: false, done: false };
}

describe('isSetNode', () => {
  it('is a set exactly when it has children', () => {
    expect(isSetNode(leaf(true, false))).toBe(false);
    expect(isSetNode(set(leaf(true, false)))).toBe(true);
  });
});

describe('nodeDue', () => {
  it('a set is due when any child is due, not when all are not-due', () => {
    expect(nodeDue(set(leaf(false, false), leaf(true, false)))).toBe(true);
    expect(nodeDue(set(leaf(false, false), leaf(false, false)))).toBe(false);
  });

  it('a metric never counts', () => {
    expect(nodeDue({ kind: 'metric', children: [], due: true, done: false })).toBe(false);
  });
});

describe('nodeDone', () => {
  it('a set is done when it is due and every DUE child is done', () => {
    // both due, both done
    expect(nodeDone(set(leaf(true, true), leaf(true, true)))).toBe(true);
    // both due, one not done
    expect(nodeDone(set(leaf(true, true), leaf(true, false)))).toBe(false);
  });

  it('ignores a not-due child: a set is done once its due children are done', () => {
    // Vitamins = (Vitamin D due+done, B12 not due) → done on Vitamin D alone (Done-When case).
    expect(nodeDone(set(leaf(true, true), leaf(false, false)))).toBe(true);
  });

  it('a set with no due child is not done', () => {
    expect(nodeDone(set(leaf(false, false), leaf(false, true)))).toBe(false);
  });
});

describe('nodeProgress — a nested set counts as one child', () => {
  // Morning Routine → [ Vitamins → (Vitamin D, B12), Floss ]
  const vitaminsDone = set(leaf(true, true), leaf(true, true)); // Vitamins fully done
  const vitaminsPartial = set(leaf(true, true), leaf(true, false)); // Vitamins half done

  it('counts a done nested set as one of the parent done', () => {
    const mr = set(vitaminsDone, leaf(true, false)); // Floss not yet done
    expect(nodeProgress(mr)).toEqual({ done: 1, total: 2 });
    expect(nodeDone(mr)).toBe(false);
  });

  it('a partly-done nested set is not counted done by the parent', () => {
    const mr = set(vitaminsPartial, leaf(true, true));
    expect(nodeProgress(mr)).toEqual({ done: 1, total: 2 }); // Floss done, Vitamins not
    expect(nodeDone(vitaminsPartial)).toBe(false);
  });

  it('a not-due child is excluded from the denominator', () => {
    const mr = set(leaf(true, true), leaf(false, false)); // one due+done, one not due
    expect(nodeProgress(mr)).toEqual({ done: 1, total: 1 });
  });
});

describe('Morning Routine → Vitamins → (Vitamin D, B12) — the Done-When scenario', () => {
  it('Vitamins done requires both when both are due; Morning Routine counts Vitamins as one child', () => {
    const vitamins = set(leaf(true, true), leaf(true, true)); // Vitamin D + B12 both done
    const mr = set(vitamins, leaf(true, true)); // + a sibling leaf done
    expect(nodeDone(vitamins)).toBe(true);
    expect(nodeDone(mr)).toBe(true);
    expect(nodeProgress(mr)).toEqual({ done: 2, total: 2 });

    // Untick B12 → Vitamins no longer done → Morning Routine drops to 1/2.
    const vitaminsPartial = set(leaf(true, true), leaf(true, false));
    const mr2 = set(vitaminsPartial, leaf(true, true));
    expect(nodeDone(vitaminsPartial)).toBe(false);
    expect(nodeProgress(mr2)).toEqual({ done: 1, total: 2 });
  });

  it('when B12 is not due today, Vitamins is done once Vitamin D alone is done', () => {
    const vitamins = set(leaf(true, true), leaf(false, false)); // Vitamin D due+done, B12 not due
    expect(nodeDue(vitamins)).toBe(true);
    expect(nodeDone(vitamins)).toBe(true);
    expect(nodeProgress(vitamins)).toEqual({ done: 1, total: 1 });
  });
});

/* ── Streak over a nested set (depth ≥ 3) ─────────────────────────────────────────── */

function histLeaf(schedules: HabitSchedule[], completionDays: string[]): HabitHistoryNode {
  return { kind: 'habit', children: [], schedules, completionDays: new Set(completionDays) };
}
function histSet(...children: HabitHistoryNode[]): HabitHistoryNode {
  return { kind: 'habit', children, schedules: [], completionDays: new Set() };
}

describe('projectHabitDay', () => {
  it('projects a history tree to one day, deriving set due/done', () => {
    const tree = histSet(histLeaf(DAILY, ['2026-11-18']), histLeaf(DAILY, ['2026-11-18']));
    const node = projectHabitDay(tree, '2026-11-18');
    expect(nodeDone(node)).toBe(true);
    const other = projectHabitDay(tree, '2026-11-19');
    expect(nodeDone(other)).toBe(false); // no completions that day
  });
});

describe('setStreak — nesting at depth ≥ 3', () => {
  // Morning Routine → Vitamins → Supplements → (Vitamin D, B12). Four levels; all daily.
  // The set is "done" on a day only when every leaf is completed that day.
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];

  function tree(bothDays: string[], onlyDDays: string[]): HabitHistoryNode {
    const vitaminD = histLeaf(DAILY, [...bothDays, ...onlyDDays]);
    const b12 = histLeaf(DAILY, bothDays);
    return histSet(histSet(histSet(vitaminD, b12)));
  }

  it('counts consecutive days where the whole nested set is done', () => {
    const t = tree(days, []); // both leaves done every day
    expect(setStreak(t, '2026-11-20')).toEqual({ current: 5, longest: 5 });
  });

  it('a day where one deep leaf is missed breaks the set streak', () => {
    // B12 done every day except 2026-11-18 → set not done that day.
    const bothDays = days.filter((d) => d !== '2026-11-18');
    const t = tree(bothDays, ['2026-11-18']); // Vitamin D still done 11-18, but B12 not
    // current run back from 11-20: 11-20 done, 11-19 done, 11-18 broken → current 2.
    expect(setStreak(t, '2026-11-20')).toEqual({ current: 2, longest: 2 });
  });

  it('an unfinished set today does not break the streak', () => {
    // Done through 11-19; nothing completed 11-20 yet.
    const through = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
    const t = tree(through, []);
    expect(setStreak(t, '2026-11-20')).toEqual({ current: 4, longest: 4 });
  });

  it('honours a not-due leaf via its schedule: a day only B12 is due needs only B12', () => {
    // Vitamin D: Mon/Wed/Fri. B12: daily. On Tue (11-17) only B12 is due, so the set is done on Tue
    // if B12 alone is done. Depth-3 tree.
    const MWF = 1 | 4 | 16;
    const vitaminD = histLeaf(daysOfWeek('2026-11-01', MWF), ['2026-11-16', '2026-11-18', '2026-11-20']);
    const b12 = histLeaf(DAILY, days); // every day
    const t = histSet(histSet(vitaminD, b12));
    // Every day: Tue/Thu need only B12 (done); Mon/Wed/Fri need both (both done). Full streak.
    expect(setStreak(t, '2026-11-20').current).toBe(5);
  });
});
