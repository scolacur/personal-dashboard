// Types for the Task Monitor "Tasks" Kanban — the project's Ticket backlog.
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

/**
 * The assignee a lane forces on entry, or `null` if the lane leaves assignee free.
 *
 * D-044: entering a queue lane makes "queued = assigned" true in the data layer —
 * `robot_queue` ⇒ `robot`, `steve_queue` ⇒ `steve` — overriding any prior value or
 * hint, so the invariant holds no matter who writes (the griller, a manual board
 * drag, or the API). In `backlog`/`prioritized`/`completed`/`closed`, assignee is a
 * free optional hint and this returns `null` (leave it as provided). The store layer
 * (createTicket/updateTicket) is the single enforcement point.
 */
export function laneForcedAssignee(status: TicketStatus): TicketAssignee | null {
  switch (status) {
    case 'robot_queue':
      return 'robot';
    case 'steve_queue':
      return 'steve';
    default:
      return null;
  }
}

// The Kanban lanes (DECISIONS D-040 board redesign, PD-245). All six are the `status`.
//  - backlog / prioritized: set by hand (prioritized = pre-grill triage, "do this next").
//  - robot_queue: ONE lane for a ticket dispatched to Sortie — every non-terminal
//    `sortie:*` label lives here; the fine state (queued/in-progress/in-review/…) is
//    carried by `agentState` and shown as a status pill. Entering this lane is the
//    dispatch trigger (mints the GitHub issue).
//  - steve_queue: work Steve does under his own supervision (manual, never agent-locked).
//  - completed: agent-set terminal (sortie:done). closed: manual/wontfix terminal (D-036),
//    hidden by default.
export type TicketStatus =
  | 'backlog'
  | 'prioritized'
  | 'robot_queue'
  | 'steve_queue'
  | 'completed'
  | 'closed';

// Priority is a P0–P5 scale (P0 most urgent). A ticket's priority may also be
// *unset* — represented as `null` in the domain/API (see AgentTicket.priority).
export type TicketPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

// Fine-grained agent state, derived by the GitHub-label poller (PD-165) from the
// `sortie:*` label on a linked issue. In the redesigned board (D-040) every non-terminal
// sortie:* label maps to the single `robot_queue` status, so `agentState` is what
// distinguishes them on the card (rendered as a status pill). Only 'working' drives the
// active-work shimmer; 'stuck'/'needs-human'/'awaiting-human' are paused-need-attention;
// 'queued'/'in-review' are informational; 'done' is terminal (the ticket sits in the
// `completed` lane but keeps a green pill so a Sortie-completed issue is distinguishable
// from a manually-closed one). `null` = no agent state (manual / not worked).
export type AgentState =
  | 'queued'
  | 'working'
  | 'in-review'
  | 'stuck'
  | 'needs-human'
  | 'awaiting-human'
  | 'wontfix'
  | 'done';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'backlog',
  'prioritized',
  'robot_queue',
  'steve_queue',
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

/** Short labels for each agent state (displayed in pills and the status-legend modal). */
export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  queued: 'queued',
  working: 'in progress',
  'in-review': 'in review',
  stuck: 'stuck',
  'needs-human': 'needs human',
  'awaiting-human': 'awaiting human',
  wontfix: 'wontfix',
  done: 'done',
};

// These stay PLAIN TEXT: the status-legend modal renders them via `{...}` interpolation
// (apps/web/.../task-monitor/+page.svelte), so any inline markdown/HTML would show as literal
// syntax. The concepts named below — the watchdog, the autonomous loop, ask_human, the
// sortie:* state machine — are documented in docs/sortie.md, which the legend modal links to
// via a "Sortie integration wiki" footer link rather than by embedding markup in these strings
// (PD-262). See also #145 (Karpathy memory model).
/** One-sentence descriptions for each agent state, shown in the status-legend modal. */
export const AGENT_STATE_DESCRIPTIONS: Record<AgentState, string> = {
  queued: 'Picked up by Sortie and waiting in the autonomous loop to start.',
  working: 'A Sortie agent is actively working the issue right now.',
  'in-review': 'The run succeeded and a PR is open, awaiting human review.',
  stuck:
    'The run stalled/gave up and was flagged by the watchdog; needs human intervention.',
  'needs-human':
    "A PR exists but the automated review-feedback loop hit its cap; a human must drive it home.",
  'awaiting-human':
    'The agent deliberately paused after asking a question (ask_human) and is waiting on a reply. Least urgent / expected.',
  wontfix: "Terminal: the issue was closed as won't-fix.",
  done: 'Terminal: Sortie finished the work and the issue is sortie:done (green pill; lives in the Completed lane).',
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
  /** Live Refine session state derived from the ticket's refine_* thread (D-044, PD-268);
   *  null = no Refine session started. */
  refineState: RefineState | null;
  /** Whether this ticket has been refined to completion at least once (D-044, PD-268).
   *  Persistent marker: gates the Refine button (hidden once true) and shows a ✓. Flipped
   *  by the commit/approval step (PD-269) or the manual "Mark refined" control. */
  refined: boolean;
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
  /** Who the ticket is assigned to. Defaults to `null` when omitted. */
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
  /** Mark the ticket refined (D-044, PD-268). Omit to leave unchanged. */
  refined?: boolean;
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

// ── Notification Center (D-040) ──────────────────────────────────────────────
// A notification surfaced in the dashboard's in-app inbox. MVP kinds cover an agent
// parking for a human (ask_human / needs-human); widget notifications plug in later.
// 'agent_refine' (D-044, PD-267): the Refine/griller agent posted a turn (plan, questions,
// or needs-full-grill) on a ticket's Refine thread and wants Steve's attention.
export type NotificationKind = 'agent_awaiting_human' | 'agent_needs_human' | 'agent_refine';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'agent_awaiting_human',
  'agent_needs_human',
  'agent_refine',
] as const;

export interface AgentNotification {
  id: number;
  kind: NotificationKind;
  /** The ticket this notification is about, if any (null for non-ticket sources). */
  ticketId: number | null;
  /** Ticket display-id (e.g. 'PD-7') for linking/display; null when unresolved. */
  ticketDisplayId: string | null;
  title: string;
  /** Free-text detail — e.g. the agent's ask_human question. */
  body: string | null;
  /** Unix ms when marked read; null = unread. */
  readAt: number | null;
  createdAt: number;
}

/** The HTML-comment marker the Notification Center puts on a forwarded human reply so
 *  the `sortie-ask-human` Action (PD-133) re-queues the parked agent. */
export const HUMAN_REPLY_MARKER = '<!-- sortie:human-reply -->';

// ── Ticket activity log + Refine thread (D-044, PD-267) ──────────────────────
// The `agent_ticket_events` table is the generic per-ticket activity log (created /
// status_changed / assignee_changed / archived / …). PD-267 adds two Refine event
// types that together form the persistent Refine conversation; PD-255 will render
// the rest of the log on the ticket-detail page over this same shape.

/** A row from the ticket activity log. Generic substrate — `detail` shape depends on
 *  `type` (the Refine subset uses `RefineDetail`). `GET /tickets/:id/events` returns these. */
export interface TicketEvent {
  id: number;
  ticketId: number;
  type: string;
  /** Parsed JSON detail, or null. */
  detail: unknown;
  createdAt: number;
}

/** Who authored a Refine turn. `human` = Steve (kickoff = the ticket body, then replies);
 *  `agent` = the griller (Claude Agent SDK / Opus) — a plan, clarifying questions, or a
 *  needs-full-grill verdict. */
export type RefineRole = 'human' | 'agent';

/** The two `agent_ticket_events.type` values that carry the Refine thread. Referenced by
 *  BOTH the server (read endpoint + reply write) and the griller (poll + post), so the
 *  string literals live here to keep the two processes in lockstep. */
export const REFINE_EVENT_TYPE: Record<RefineRole, string> = {
  human: 'refine_human',
  agent: 'refine_agent',
} as const;

/** JSON stored in a refine_* event's `detail`. Agent turns also persist the Claude Agent
 *  SDK `sessionId` so the griller can `resume` the thread after a restart (rehydrated
 *  from the newest refine_agent event — no separate session table). */
export interface RefineDetail {
  text: string;
  /** Present only on refine_agent turns; the SDK session id to resume from. */
  sessionId?: string;
}

/** A single Refine turn, projected from a refine_* `TicketEvent` for the thread UI. */
export interface RefineMessage {
  id: number;
  ticketId: number;
  role: RefineRole;
  text: string;
  createdAt: number;
}

/** True for the two Refine event types. */
export function isRefineEventType(type: string): boolean {
  return type === REFINE_EVENT_TYPE.human || type === REFINE_EVENT_TYPE.agent;
}

/** Live Refine session state, for the card/detail pill (D-044, PD-268). Derived from the
 *  newest refine_* turn: `grilling` = the agent is working / about to (Steve's turn is
 *  newest); `awaiting-human` = the agent replied and is waiting on Steve. (`done` arrives
 *  with the commit step, PD-269.) */
export type RefineState = 'grilling' | 'awaiting-human';

/** Map the newest refine_* event type to a session state, or null if none. */
export function refineStateFromLatestType(latestRefineType: string | null | undefined): RefineState | null {
  if (latestRefineType === REFINE_EVENT_TYPE.agent) return 'awaiting-human';
  if (latestRefineType === REFINE_EVENT_TYPE.human) return 'grilling';
  return null;
}

/** Project the Refine subset of a ticket's activity log into ordered thread messages.
 *  Non-refine events are dropped; malformed detail falls back to empty text. Shared so the
 *  web thread view and the griller's "what has been said so far" agree exactly. */
export function refineThreadFromEvents(events: TicketEvent[]): RefineMessage[] {
  const out: RefineMessage[] = [];
  for (const e of events) {
    const role: RefineRole | null =
      e.type === REFINE_EVENT_TYPE.human ? 'human' : e.type === REFINE_EVENT_TYPE.agent ? 'agent' : null;
    if (!role) continue;
    const detail = (e.detail ?? {}) as Partial<RefineDetail>;
    out.push({
      id: e.id,
      ticketId: e.ticketId,
      role,
      text: typeof detail.text === 'string' ? detail.text : '',
      createdAt: e.createdAt,
    });
  }
  return out;
}
