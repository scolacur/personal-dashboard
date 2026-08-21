import type { AgentTicket, TicketAssignee, TicketPriority, TicketStatus } from '@dashboard/shared';

/**
 * The add/edit modal's field values. Held as one `$state` object on the page and mutated in place
 * by the modal, so the page keeps the submit/bypass logic (which needs to read the fields) without
 * threading a dozen `$bindable` props through the boundary.
 */
export interface TicketFormState {
  title: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority | null;
  assignee: TicketAssignee | null;
  /** D-054: whether this ticket is an Epic. The board's Epic `+` and the form checkbox both set it. */
  isEpic: boolean;
  /** D-054: which Epic this ticket belongs to; null = none. Forced null when `isEpic`. */
  epicId: number | null;
  /** PD-432: the per-ticket run ceiling as typed text, so an empty field is unambiguously
   *  "default" rather than 0. Parsed on submit. */
  maxTurns: string;
  projectId: number | null;
}

/** A blank form for a new ticket in `status`. Priority starts unset — it is assigned deliberately. */
export function emptyTicketForm(status: TicketStatus, projectId: number | null): TicketFormState {
  return {
    title: '',
    body: '',
    status,
    priority: null,
    assignee: null,
    isEpic: false,
    epicId: null,
    maxTurns: '',
    projectId,
  };
}

/** The form pre-filled from an existing ticket. */
export function ticketToForm(ticket: AgentTicket, fallbackProjectId: number | null): TicketFormState {
  return {
    title: ticket.title,
    body: ticket.body ?? '',
    status: ticket.status,
    priority: ticket.priority,
    assignee: ticket.assignee,
    isEpic: ticket.isEpic,
    epicId: ticket.epicId,
    maxTurns: ticket.maxTurns === null ? '' : String(ticket.maxTurns),
    projectId: ticket.projectId ?? fallbackProjectId,
  };
}
