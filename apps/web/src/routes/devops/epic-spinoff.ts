import type { AgentTicket, TicketPriority, TicketStatus } from '@dashboard/shared';

/**
 * Spinning a Ticket out into its own Epic (D-080 slice C, PD-509).
 *
 * Under D-080 the Epic is the unit of priority AND dispatch, so a Ticket that needs to be
 * scheduled differently from its siblings cannot simply be re-ranked — it needs its own Epic.
 * That makes spin-off the standard escape hatch rather than a special case, and it is the same
 * move slice B's rollback "bump" makes for a ticket whose run cannot be stopped.
 *
 * The new Epic inherits the source Epic's **priority and lane**. Lane matters as much as priority:
 * spinning a ticket out of a queued Epic into a backlog Epic would silently un-queue live work,
 * which is precisely the kind of invisible state change slice B existed to remove.
 */
export interface SpinOffPlan {
  /** Suggested name for the new Epic — prefilled, and editable before it is created. */
  title: string;
  priority: TicketPriority | null;
  /** The Epic's own status. `backlog` or `queue` only; a terminal lane is derived from members. */
  status: TicketStatus;
  /** What the values were taken from, so the UI can say so rather than assert a bare fact. */
  inheritedFrom: 'epic' | 'ticket';
}

/**
 * Plan a spin-off. `sourceEpic` is the Ticket's current Epic, if it has one.
 *
 * With no source Epic (an orphan — the board still holds pre-D-080 ones) the Ticket's own
 * priority and lane are the only signal available, so they are used instead. A terminal ticket
 * lands its new Epic in `backlog`: an Epic's terminal lanes are derived from its members, so
 * asserting one directly would be overruled on the next render.
 */
export function planSpinOff(ticket: AgentTicket, sourceEpic: AgentTicket | undefined): SpinOffPlan {
  const from = sourceEpic ?? ticket;
  const status = from.status === 'queue' ? 'queue' : 'backlog';
  return {
    title: ticket.title,
    priority: from.priority,
    status,
    inheritedFrom: sourceEpic ? 'epic' : 'ticket',
  };
}
