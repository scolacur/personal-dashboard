// Types for the Agent Dashboard "Tasks" Kanban — the project's Ticket backlog.
// Shared between the server (DB + API) and the web (Kanban UI).

// Who the ticket is assigned to. 'steve' = human owner; 'robot' = agent/Sortie.
// null = unassigned.
export type TicketAssignee = 'steve' | 'robot';

export const TICKET_ASSIGNEES: readonly TicketAssignee[] = ['steve', 'robot'] as const;

/** Short label for each assignee value (shown in the create/edit modal). */
export const ASSIGNEE_LABELS: Record<TicketAssignee, string> = {
  steve: 'Steve',
  robot: 'Robot',
};

// The Kanban columns. Backlog/ready/queued/closed are set by hand; the agent statuses
// (in_progress/in_review/completed) are derived from GitHub once a Ticket has been
// converted to a Sortie issue (Phase 3) — see DECISIONS.md D-020.
// 'closed' is a manual terminal status for tickets closed for any reason other than
// completion (cancelled, won't fix, out of scope, etc.) — see DECISIONS.md D-034.
export type TicketStatus =
  | 'backlog'
  | 'ready'
  | 'queued'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'closed';

// Priority is a P0–P5 scale (P0 most urgent). A ticket's priority may also be
// *unset* — represented as `null` in the domain/API (see AgentTicket.priority).
export type TicketPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

// Fine-grained agent state, derived by the GitHub-label poller (PD-165) from the
// `sortie:*` label on a linked issue. Distinct from `status`: several of these map
// to the same `in_progress` status but mean different things — only 'working'
// should drive the active-work shimmer; 'stuck'/'needs-human'/'awaiting-human' are
// paused-and-need-attention. `null` = no agent state (manual / not being worked).
export type AgentState = 'working' | 'stuck' | 'needs-human' | 'awaiting-human' | 'wontfix';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'backlog',
  'ready',
  'queued',
  'in_progress',
  'in_review',
  'completed',
  'closed',
] as const;

export const TICKET_PRIORITIES: readonly TicketPriority[] = [
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
] as const;

/** Short label for each priority level (shown in the priority legend). */
export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  P0: 'Urgent',
  P1: 'Top Priority',
  P2: 'Important',
  P3: 'Medium Importance',
  P4: 'Low Importance',
  P5: 'Window Dressing',
};

/** Longer descriptions for the priority-legend modal. */
export const PRIORITY_DESCRIPTIONS: Record<TicketPriority, string> = {
  P0: 'Reserved for time-sensitive things like open security threats, leaked credentials, etc.',
  P1: 'Top priority.',
  P2: 'Important.',
  P3: 'Medium importance.',
  P4: 'Low importance.',
  P5: 'Window dressing.',
};

// A project the Tickets belong to (personal-dashboard, core, nervous-system-website, …).
// The dashboard tracks Tickets across all projects, not just itself.
export interface AgentProject {
  id: number;
  slug: string;
  name: string;
  /** Display-id prefix, e.g. 'PD' → tickets are PD-1, PD-2, … */
  key: string | null;
  /** 'owner/repo' for Phase-3 issue creation; null if the project isn't on GitHub. */
  githubRepo: string | null;
  /** Whether "Convert to Sortie issue" applies to this project. */
  sortieEnabled: boolean;
  /** Hex color for the project chip on cards. */
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  githubRepo?: string | null;
  sortieEnabled?: boolean;
  color?: string | null;
}

export interface AgentTicket {
  id: number;
  /** Human-facing per-project id, e.g. 'PD-7'. Null only for legacy rows. */
  displayId: string | null;
  title: string;
  body: string | null;
  status: TicketStatus;
  /** P0–P5, or `null` when priority is unset. */
  priority: TicketPriority | null;
  /** The project this Ticket belongs to. */
  projectId: number | null;
  /** Human or agent that owns the ticket. */
  assignee: TicketAssignee | null;
  /** Recurrence hint for maintenance tickets, e.g. 'weekly'. */
  recurInterval: string | null;
  /** 'manual', or 'seed:<path>' for tickets imported from a TODO.md/META-TODOS.md file. */
  source: string;
  /** Ordering within a column (ascending); fractional to allow drag-reorder. */
  sortOrder: number;
  /** Set when the Ticket is converted to a GitHub issue (Phase 3). */
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  /** Fine-grained agent state derived from the linked issue's `sortie:*` label (PD-165); null = none. */
  agentState: AgentState | null;
  /** Soft-delete timestamp; null = active. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Fields accepted when creating a Ticket. New items land in `backlog` unless `status` is given. */
export interface CreateTicketInput {
  title: string;
  projectId: number;
  body?: string | null;
  /** P0–P5, or `null`/omitted for unset. */
  priority?: TicketPriority | null;
  /** Override the initial status (used by the seed importer for completed items). */
  status?: TicketStatus;
  /** Provenance, e.g. 'seed:widgets/pomodoro-timer/TODO.md'. Defaults to 'manual'. */
  source?: string;
  /**
   * Force a specific display-id (e.g. 'PD-42') instead of allocating the next one.
   * Used only by the seed importer to preserve ids across a restore; normal creates
   * (API, UI) omit this and get the next per-project id. The project's `seq` counter
   * is advanced past the forced number so later auto-allocations don't collide.
   */
  displayId?: string | null;
  /** Who the ticket is assigned to. Defaults to 'steve' when omitted. */
  assignee?: TicketAssignee | null;
}

/** Partial update — any subset of these fields. */
export interface UpdateTicketInput {
  title?: string;
  body?: string | null;
  status?: TicketStatus;
  /** P0–P5, or `null` to unset. Omit to leave unchanged. */
  priority?: TicketPriority | null;
  sortOrder?: number;
  projectId?: number;
  /** 'steve' | 'robot', or `null` to unassign. Omit to leave unchanged. */
  assignee?: TicketAssignee | null;
  /** Link (or unlink, via `null`) a GitHub issue. Set together. Omit to leave unchanged. */
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
}

/**
 * The four section headers the `/to-sortie-issues` Refine flow produces.
 * `## Done When` also accepts a `(acceptance checklist)` suffix.
 * All matched case-insensitively, tolerant of trailing text on the heading line.
 */
const SORTIE_REQUIRED_HEADERS = [
  /^## context/im,
  /^## task/im,
  /^## done when/im,
  /^## out of scope/im,
] as const;

/**
 * Returns true iff `body` contains all four Sortie-ready section headers.
 * A ticket must pass this check before it can be meaningfully consumed by the
 * issue-creation poller (PD-164) without additional reformatting.
 */
export function isSortieReady(body: string | null): boolean {
  if (!body) return false;
  return SORTIE_REQUIRED_HEADERS.every((re) => re.test(body));
}
