import type { AgentTicket, EpicDerivedLane, TicketPriority, TicketStatus } from '@dashboard/shared';

/**
 * How the board orders things — both bands, in one file (PD-538).
 *
 * The two comparators live together deliberately. They were apart, and they drifted: the Ticket
 * band sorted by priority then `sortOrder`, while the Epic band (`buildEpicBand`) sorted by
 * `sortOrder` alone and never consulted priority at all. That was correct under D-054, when an
 * Epic's lane was derived and hand-ordering was the only signal the band carried. D-080 changed what
 * the band is *for* — the Epic became the unit of priority and dispatch — and the ordering did not
 * follow, so a P4 Epic could sit above a P1 purely because someone had dragged it there.
 *
 * Read them side by side and a disagreement is obvious. Split across two modules it was invisible
 * for three months.
 */

/**
 * Priority as a sortable rank, unset last.
 *
 * Keyed by string rather than `TicketPriority` because callers also look up values read back out of
 * the DOM (`data-priority`, where an unset priority is the literal `'none'`).
 *
 * **This is the one definition.** `sort-logic` and `board-drag` each had their own copy; they
 * happened to agree, which is the only reason nothing broke. `board-drag` now re-exports this one.
 */
export const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, none: 6 };

export function rankOf(p: TicketPriority | null): number {
  return PRIORITY_RANK[p ?? 'none'];
}

/**
 * Comparator for tickets within a board column.
 * Completed and closed columns sort by recency (most recently updated first);
 * all other columns sort by priority then sort_order.
 */
export function compareTicketsInColumn(status: TicketStatus, a: AgentTicket, b: AgentTicket): number {
  if (status === 'completed' || status === 'closed') {
    return b.updatedAt - a.updatedAt;
  }
  return rankOf(a.priority) - rankOf(b.priority) || a.sortOrder - b.sortOrder;
}

/**
 * Comparator for Epics within a band lane — the same rule as the Ticket band above.
 *
 * **Pending lanes read in dispatch order.** The loop selects with
 *
 * ```sql
 * ORDER BY t.priority ASC, COALESCE(e.sort_order, 0) ASC, t.sort_order ASC
 * ```
 *
 * so priority leads and `sort_order` only ranks Epics *against others of the same priority*. The
 * band now shows exactly that, which means a drag still reorders an Epic but can no longer move it
 * out of its priority band — the drop is clamped the same way the Ticket band's is
 * (`pickBeforeId`), and `computeSortOrder` picks the fractional order within the band.
 *
 * **Terminal lanes read by recency**, matching `compareTicketsInColumn` rather than the letter of
 * PD-538. Nothing in Completed or Closed is going to be dispatched, so ranking finished Epics by
 * priority sorts them on an attribute that has stopped mattering; "what finished most recently" is
 * the question those lanes actually get asked. They are not drop targets either, so no gesture
 * disagrees with the ordering.
 *
 * `id` is the final tie-break so the order is total — two Epics at the same priority and
 * `sortOrder` must not swap places between renders.
 */
export function compareEpicsInLane(lane: EpicDerivedLane, a: AgentTicket, b: AgentTicket): number {
  if (lane === 'completed' || lane === 'closed') {
    return b.updatedAt - a.updatedAt || a.id - b.id;
  }
  return rankOf(a.priority) - rankOf(b.priority) || a.sortOrder - b.sortOrder || a.id - b.id;
}
