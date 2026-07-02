import type { AgentTicket, TicketPriority, TicketStatus } from '@dashboard/shared';

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, none: 6 };

function rankOf(p: TicketPriority | null): number {
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
