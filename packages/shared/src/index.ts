// Shared types between server and web.
// Import from '@dashboard/shared' in both apps.
export type {
  TicketStatus,
  TicketPriority,
  TicketAssignee,
  AgentState,
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
  AGENT_STATE_LABELS,
  AGENT_STATE_DESCRIPTIONS,
  isSortieReady,
} from './agent-dashboard';
