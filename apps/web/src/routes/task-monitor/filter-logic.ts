import type { AgentTicket } from '@dashboard/shared';

export function ticketMatchesQuery(ticket: AgentTicket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${ticket.displayId ?? ''} ${ticket.title} ${ticket.body ?? ''}`.toLowerCase().includes(q);
}
