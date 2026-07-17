import type { AgentTicket, TicketAssignee } from '@dashboard/shared';

export function ticketMatchesQuery(ticket: AgentTicket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${ticket.displayId ?? ''} ${ticket.title} ${ticket.body ?? ''}`.toLowerCase().includes(q);
}

/** Table-wide assignee filter (D-058, PD-399): the single Queue lane intermixes robot- and
 *  steve-assigned cards, so the board filters by assignee across every lane. `'none'` matches
 *  unassigned tickets; `'all'` matches everything. */
export type AssigneeFilter = 'all' | TicketAssignee | 'none';

export function ticketMatchesAssigneeFilter(ticket: AgentTicket, filter: AssigneeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return ticket.assignee === null;
  return ticket.assignee === filter;
}

export type RefineFilter = 'all' | 'refined' | 'refining' | 'awaiting-human' | 'unrefined';

export function ticketMatchesRefineFilter(ticket: AgentTicket, filter: RefineFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'refined') return ticket.refined;
  if (filter === 'refining') return ticket.refineState === 'refining';
  if (filter === 'awaiting-human') return ticket.refineState === 'awaiting-human';
  return !ticket.refined && ticket.refineState === null;
}
