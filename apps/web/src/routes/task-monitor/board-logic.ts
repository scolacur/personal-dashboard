import type { AgentTicket, TicketPriority, TicketStatus } from '@dashboard/shared';

// Statuses whose lane is owned by the agent pipeline. A ticket assigned to
// `robot` in one of these is locked from manual edit/move on the board.
export const AGENT_CONTROLLED: TicketStatus[] = ['robot_queue', 'completed'];

/**
 * A ticket is locked (not manually editable / draggable) when the robot owns it
 * and it sits in an agent-controlled lane. Steve-owned or backlog/prioritized
 * tickets stay editable.
 */
export function isStatusLocked(t: AgentTicket): boolean {
  return t.assignee === 'robot' && AGENT_CONTROLLED.includes(t.status);
}

/**
 * Compute the fractional `sortOrder` for a card dropped within its priority band.
 *
 * `columnTickets` is the column's tickets already filtered + sorted for display
 * (i.e. what `byStatus(status)` returns). We narrow to the dragged card's own
 * priority band — a card can only be reordered within its band — excluding the
 * dragged card itself, then place it between its new neighbours using the
 * midpoint of their sort orders.
 *
 * `beforeId` is the id of the card the dragged card is being dropped in front of,
 * or `null` to append to the band's end. A `beforeId` pointing outside the band
 * (a band boundary) is treated as append.
 */
export function computeSortOrder(
  columnTickets: AgentTicket[],
  priority: TicketPriority | null,
  beforeId: number | null,
  draggedId: number,
): number {
  const band = columnTickets.filter((t) => t.priority === priority && t.id !== draggedId);
  // beforeId may point at a card outside the band (the boundary) or be null → append to band end.
  let idx = beforeId === null ? band.length : band.findIndex((t) => t.id === beforeId);
  if (idx === -1) idx = band.length;
  const prev = band[idx - 1];
  const next = band[idx];
  if (!prev && !next) return 0;
  if (!prev) return next.sortOrder - 1;
  if (!next) return prev.sortOrder + 1;
  return (prev.sortOrder + next.sortOrder) / 2;
}
