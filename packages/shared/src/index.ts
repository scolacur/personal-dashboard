// Shared types between server and web.
// Import from '@dashboard/shared' in both apps.
export type {
  TicketStatus,
  TicketPriority,
  TicketAssignee,
  AgentTicket,
  CreateTicketInput,
  UpdateTicketInput,
  AgentProject,
  CreateProjectInput,
} from './agent-dashboard';
export {
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_DESCRIPTIONS,
  TICKET_ASSIGNEES,
  ASSIGNEE_LABELS,
  isSortieReady,
} from './agent-dashboard';
