// Shared types between server and web.
// Import from '@dashboard/shared' in both apps.
export type {
  TicketStatus,
  TicketPriority,
  AgentTicket,
  CreateTicketInput,
  UpdateTicketInput,
  AgentProject,
  CreateProjectInput,
} from './agent-dashboard';
export { TICKET_STATUSES, TICKET_PRIORITIES } from './agent-dashboard';
export { formatTime, advancePhase, clampRoundsBeforeLongBreak } from './pomodoro';
export type { PomodoroPhase, PomodoroConfig, PomodoroTransition } from './pomodoro';
