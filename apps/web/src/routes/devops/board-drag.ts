import type { AgentTicket, TicketStatus } from '@dashboard/shared';
import { PRIORITY_RANK, rankOf } from './sort-logic';

/**
 * Priority rank, re-exported from `sort-logic` (PD-538).
 *
 * This module had its own identical copy. Two definitions of the ranking the whole board depends on
 * is a drift waiting to happen — and the board *had* already drifted on ordering, which is the bug
 * PD-538 fixes. `sort-logic` owns it now: that is the module about ordering, and the two band
 * comparators live there together. Re-exported here because `board-drag`'s own API is what the drag
 * code and its tests import.
 */
export { PRIORITY_RANK, rankOf };

/**
 * The drag maths behind the board's ticket band (PD-554).
 *
 * Pulled out of `task-tracker/+page.svelte` when the board became a reusable component. It was the
 * one piece of the drag that had real rules — cards are banded by priority, and a drop is clamped
 * to its own band — and it lived inside a DOM event handler, so nothing tested it. `apps/web` has
 * no component-rendering tests, so logic in a `.svelte` file is logic without coverage.
 *
 * The component still does the DOM part (reading rects); this decides what those measurements mean.
 */

/** One candidate card the cursor could land before, already measured. */
export interface DropCandidate {
  id: number;
  /** The card's priority as stored in `data-priority` — `'none'` when unset. */
  priority: string;
  /** The vertical midpoint of the card, in the same coordinate space as the cursor. */
  midpointY: number;
}

/**
 * The card the dragged ticket should be inserted before, or null to append.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *  1. **Only same-priority cards are insertion points.** The lane is banded by priority, so landing
 *     between two P3s when you are dragging a P1 would put the card somewhere it cannot render.
 *  2. **Falling past the last card of your own band means the end of that band, not the end of the
 *     lane** — which is the first card of the next, lower band. Without this a P1 dropped low in a
 *     lane would be appended after the P3s, and then snap back up on the next read, looking like
 *     the drop was ignored.
 *
 * `candidates` must already exclude the dragged card itself and be in visual order.
 */
export function pickBeforeId(
  candidates: DropCandidate[],
  draggedPriority: AgentTicket['priority'],
  cursorY: number,
): number | null {
  const rank = rankOf(draggedPriority);
  for (const c of candidates) {
    if (PRIORITY_RANK[c.priority] !== rank) continue;
    if (cursorY < c.midpointY) return c.id;
  }
  const nextBand = candidates.find((c) => PRIORITY_RANK[c.priority] > rank);
  return nextBand ? nextBand.id : null;
}

/**
 * Whether a drop would change nothing, so the round-trip can be skipped.
 *
 * Worth its own function because "nothing changed" is the common case — most drags end where they
 * started — and a needless PATCH there costs a full board reload, which reads as a flicker.
 */
export function moveIsNoop(
  ticket: Pick<AgentTicket, 'status' | 'sortOrder'>,
  status: TicketStatus,
  sortOrder: number,
): boolean {
  return ticket.status === status && ticket.sortOrder === sortOrder;
}

/**
 * Whether dropping this ticket into `status` needs the explicit Ready-bypass acknowledgement
 * (D-058).
 *
 * Only entering the queue, only for the Robot's work, and only when the body is not Ready-shaped
 * and no bypass has already been recorded. A ticket already in the queue is not re-asked.
 */
export function needsQueueBypass(
  ticket: Pick<AgentTicket, 'status' | 'assignee' | 'ready' | 'readyBypassed'>,
  status: TicketStatus,
): boolean {
  return (
    status === 'queue' &&
    ticket.status !== 'queue' &&
    ticket.assignee === 'robot' &&
    !ticket.ready &&
    !ticket.readyBypassed
  );
}
