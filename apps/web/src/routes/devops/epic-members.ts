import type { AgentTicket, TicketAssignee, TicketStatus } from '@dashboard/shared';
import { REFINE_STATE_LABELS } from '@dashboard/shared';
import { isReadOnly, isTerminal } from './board-logic';

/**
 * The Epic detail page's member list (PD-384, slice D of D-080).
 *
 * The list is not decoration. Under D-080 a Ticket has no priority of its own, so a member's
 * `sortOrder` **is** the order its Epic's work is dispatched in — it is the third key of
 * `robotQueueCandidates`' `ORDER BY epic.priority, epic.sortOrder, t.sortOrder, t.id`. Dragging a
 * row here is how order-of-operations is expressed now that `blocks` is reserved for true
 * dependencies (a `blocks` chain through a 15-member Epic would leave exactly one member
 * dispatchable at a time).
 *
 * Kept in plain `.ts` because `apps/web` has no component-rendering tests — logic that lives in a
 * `.svelte` file is logic with no coverage.
 */

/**
 * The lanes a member can be moved to from the Epic page, in menu order.
 *
 * Terminal lanes are deliberately absent. Entering `completed`/`closed` is not reversible from a
 * list row (D-083: terminal is final, and leaving it is a deliberate Reopen on the ticket's
 * own detail page), and a one-click dropdown is exactly the "easy slip" that decision exists to
 * prevent. Completing a member stays a decision made on that member, where the Reopen affordance
 * that undoes it also lives.
 */
export const MEMBER_LANE_CHOICES: readonly TicketStatus[] = ['backlog', 'queue'] as const;

/**
 * Whether this member's lane may be changed from the Epic page.
 *
 * `isReadOnly` covers both halves already: a terminal member is frozen (D-083) and a
 * robot-completed one is status-locked (D-058). Stated as its own function so the row has one
 * thing to ask, and so the reason a row is inert is testable without rendering it.
 */
export function canSetMemberLane(m: AgentTicket): boolean {
  return canEditMember(m);
}

/**
 * Whether any of this member's fields may be edited from the Epic page.
 *
 * One predicate behind both the lane control and the assignee control, so a frozen row cannot end
 * up half-editable — which is exactly the state a reader would read as a bug rather than a rule.
 */
export function canEditMember(m: AgentTicket): boolean {
  return !isReadOnly(m);
}

/**
 * The assignee options a member row offers, in menu order (PD-532).
 *
 * `null` is first and is a real choice, not an empty state: D-058 made assignee an axis
 * independent of lane, so "nobody has taken this yet" is a position, and un-assigning is a move
 * someone actually makes.
 */
export const MEMBER_ASSIGNEES: readonly (TicketAssignee | null)[] = [null, 'steve', 'robot'] as const;

/**
 * The one-glyph label for an assignee, matching the board's ticket cards exactly.
 *
 * The point of PD-532 is that the member list and the board are scannable the same way, so this
 * duplicates the card's mapping deliberately rather than inventing a second vocabulary — and lives
 * here, in tested code, so the two cannot drift silently.
 */
export function assigneeGlyph(assignee: TicketAssignee | null): string {
  if (assignee === 'steve') return 'S';
  if (assignee === 'robot') return '🤖';
  return '—';
}

/**
 * Why this member is or is not a dispatch candidate, for the assignee control's tooltip.
 *
 * Assignee is the field that decides it (`robotQueueCandidates` requires `assignee = 'robot'`), and
 * a queued row assigned to Steve looks identical to a queued row assigned to the Robot unless the
 * row says so. This is the sentence that makes the badge worth having rather than decorative.
 */
export function memberAssigneeHint(m: AgentTicket): string {
  if (m.assignee === 'robot') {
    return m.status === 'queue'
      ? 'Assigned to the Robot — queued, so it is a dispatch candidate'
      : 'Assigned to the Robot — not queued, so nothing will pick it up yet';
  }
  if (m.assignee === 'steve') return 'Assigned to Steve — a personal to-do, never dispatched';
  return 'Unassigned — never dispatched until someone takes it';
}

/**
 * Why a member row is inert, phrased for a `title=`/tooltip — or null when it is editable.
 *
 * A disabled control with no explanation reads as a bug. These are the only two reasons.
 */
export function memberLockReason(m: AgentTicket): string | null {
  if (isTerminal(m)) return 'Completed and closed tickets are read-only — reopen it from its own page';
  if (isReadOnly(m)) return 'The Robot completed this ticket — its status is locked';
  return null;
}

/**
 * Whether members may be re-ordered by dragging at all.
 *
 * Below two members there is no order to express, and a drag affordance on a single row invites a
 * gesture that cannot do anything. This is about the list, not about any one row: a frozen member
 * still *has* a position in the dispatch order, so it stays draggable — freezing a ticket's content
 * says nothing about when it should be worked.
 */
export function membersReorderable(members: AgentTicket[]): boolean {
  return members.length > 1;
}

/**
 * The member list after a drag, without waiting for the server.
 *
 * The write is a single `sortOrder` PATCH (see `computeOrderWithin`), but the row must move under
 * the cursor immediately — a list that snaps back until a refetch lands reads as a failed drag, and
 * invites the user to drag again. Returns a new array; never mutates the input.
 *
 * `beforeId` is the member being dropped in front of, or null to append.
 */
export function reorderedMembers(
  members: AgentTicket[],
  draggedId: number,
  beforeId: number | null,
): AgentTicket[] {
  const dragged = members.find((m) => m.id === draggedId);
  if (!dragged) return members;
  // Dropping a row on itself is a no-op, not an append. Without this the row is removed, then
  // `beforeId` is not found in what remains, and the "not found → append" fallback silently sends
  // it to the bottom — the one gesture a user makes by accident, with the largest effect.
  if (beforeId === draggedId) return members;
  const rest = members.filter((m) => m.id !== draggedId);
  let idx = beforeId === null ? rest.length : rest.findIndex((m) => m.id === beforeId);
  if (idx === -1) idx = rest.length;
  return [...rest.slice(0, idx), dragged, ...rest.slice(idx)];
}

/**
 * The 1-based dispatch position shown on each row, or null when the member cannot be dispatched
 * from this Epic at all.
 *
 * Only `queue` + `robot` members are ever candidates, so numbering every row 1..n would promise an
 * order that most of the list is not in. Numbering just the dispatchable ones makes the list answer
 * the question it is actually asked — "what does the Robot do next out of this Epic" — and makes a
 * mis-ordered drag visible immediately rather than at dispatch time.
 */
export function dispatchPositions(members: AgentTicket[]): Map<number, number> {
  const out = new Map<number, number>();
  let n = 0;
  for (const m of members) {
    if (m.status === 'queue' && m.assignee === 'robot') out.set(m.id, ++n);
  }
  return out;
}

/**
 * What adding a member to `epic` is about to do (PD-611) — the read-side model of the server's
 * `invalidateEpicRefinement`, so the UI can say it *before* it happens.
 *
 * Returns null when there is nothing to warn about, which is the overwhelmingly common case: an
 * Epic that has never been refined has no claim to invalidate (D-089 — 78 of 80), and neither does
 * a non-Epic. Only an Epic currently reading ✓ Refined produces a plan.
 *
 * `needsConfirm` is the interesting field, and it is deliberately narrower than "the Epic is
 * running". The modal exists because **other tickets visibly leave the Queue** — so it asks only
 * when at least one member would actually be un-armed. An Epic whose only queued member is
 * mid-run has nothing to move (D-046 leaves it alone), so it gets the toast, not a modal offering
 * a choice between two identical outcomes.
 */
export interface StaleInvalidationPlan {
  /** Members that would return to Backlog if the pause proceeds. */
  unarmed: AgentTicket[];
  /** Members left running because a run cannot be interrupted (D-046). */
  inFlight: AgentTicket[];
  /** Whether to ask (Queue, work moves) rather than tell (Backlog, or nothing moves). */
  needsConfirm: boolean;
}

export function planStaleInvalidation(
  epic: Pick<AgentTicket, 'isEpic' | 'refined'>,
  members: AgentTicket[],
): StaleInvalidationPlan | null {
  if (!epic.isEpic || !epic.refined) return null;
  const queued = members.filter((m) => !isTerminal(m) && m.status === 'queue');
  const inFlight = queued.filter((m) => IN_FLIGHT_MEMBER_STATES.includes(m.agentState ?? ''));
  const unarmed = queued.filter((m) => !IN_FLIGHT_MEMBER_STATES.includes(m.agentState ?? ''));
  return { unarmed, inFlight, needsConfirm: unarmed.length > 0 };
}

/**
 * Why this Epic's members are sitting in Backlog while the Epic itself is in the Queue (PD-611).
 *
 * Without this the members section reads as a bug: an Epic in the Queue whose active set is empty,
 * and nothing on the page connecting that to the staleness banner at the top. The pause
 * (`invalidateEpicRefinement`) is what put them there, and it is silent by design (D-089 §3) — so
 * the explanation has to be reconstructed from the state it left behind.
 *
 * Returns null unless the Epic is *actually* in the paused shape: stale, still in the Queue lane,
 * and holding at least one member it could arm. An Epic that is stale in Backlog has nothing to
 * explain — nothing moved.
 *
 * `inFlight` is counted separately and is not a defect: D-046 keeps a running member running, so a
 * paused Epic legitimately has work still finishing. Saying "3 returned to Backlog" while one row
 * shows `working` would otherwise read as the pause having failed.
 */
export interface StalePauseNotice {
  /** Members the pause returned to Backlog (or that arrived after, which D-080 also lands there). */
  unarmed: number;
  /** Members left running because a run cannot be interrupted (D-046). */
  inFlight: number;
}

export function stalePauseNotice(epic: AgentTicket, members: AgentTicket[]): StalePauseNotice | null {
  if (!epic.isEpic || !epic.refineStale || epic.status !== 'queue') return null;
  const live = members.filter((m) => !isTerminal(m));
  const unarmed = live.filter((m) => m.status === 'backlog').length;
  if (unarmed === 0) return null;
  return {
    unarmed,
    inFlight: live.filter((m) => m.status === 'queue' && IN_FLIGHT_MEMBER_STATES.includes(m.agentState ?? ''))
      .length,
  };
}

/** Mirrors `IN_FLIGHT_AGENT_STATES` in `epic-drag.ts` — the states the pause deliberately skips. */
const IN_FLIGHT_MEMBER_STATES: readonly string[] = ['working', 'in-review'] as const;

/**
 * The refinement badge for a member row (PD-598).
 *
 * When refining an Epic, "which members still need shaping" is the question being asked, and the
 * member list could not answer it — you had to open each one. The board's cards have shown this all
 * along; this is the same three states, in the same order of precedence.
 *
 * `cls` matches the board's class names so both surfaces pull from `_refine-badge.scss` rather than
 * growing separate looks for one concept.
 *
 * Returns null for a terminal member: whether finished work was refined first is history, and the
 * badge would be a permanent decoration on every completed row.
 */
export interface RefinementBadge {
  text: string;
  cls: string;
  title: string;
}

export function refinementBadge(m: AgentTicket): RefinementBadge | null {
  if (isTerminal(m)) return null;
  // PD-611/D-089: the third state, and it must not read as either of the other two. Checked FIRST
  // because it is the only one that is a warning — `refined` is already 0 whenever `refineStale` is
  // 1 (the invalidation clears it), so the order is about precedence over `refineState`: an Epic
  // that went stale and then had a session opened on it is still stale, and that is the fact worth
  // showing. Only ever true on an Epic.
  if (m.refineStale) {
    return {
      text: '⚠ Stale',
      cls: 'refine-pill refine-stale',
      title: 'Was refined, but its members changed since — needs re-refinement',
    };
  }
  if (m.refined) return { text: '✓ Refined', cls: 'refined-mark', title: 'Refined' };
  if (m.refineState) {
    const label = REFINE_STATE_LABELS[m.refineState] ?? m.refineState;
    return {
      text: label,
      cls: `refine-pill refine-${m.refineState}`,
      title: `Refine session — ${label}`,
    };
  }
  return { text: 'Not refined', cls: 'refine-pill refine-start', title: 'Not refined yet' };
}
