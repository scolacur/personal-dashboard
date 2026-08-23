import type { AgentTicket, TicketStatus } from '@dashboard/shared';
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
  return !isReadOnly(m);
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
