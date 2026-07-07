import type { AgentTicket } from '@dashboard/shared';

export function ticketMatchesQuery(ticket: AgentTicket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${ticket.displayId ?? ''} ${ticket.title} ${ticket.body ?? ''}`.toLowerCase().includes(q);
}

export type RefineFilter = 'all' | 'refined' | 'grilling' | 'awaiting-human' | 'unrefined';

export function ticketMatchesRefineFilter(ticket: AgentTicket, filter: RefineFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'refined') return ticket.refined;
  if (filter === 'grilling') return ticket.refineState === 'grilling';
  if (filter === 'awaiting-human') return ticket.refineState === 'awaiting-human';
  return !ticket.refined && ticket.refineState === null;
}
