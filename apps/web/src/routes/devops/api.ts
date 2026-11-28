import type {
  AgentProject,
  AwaitingRefineItem,
  AwaitingVisualItem,
  RefineAnswerSet,
  AgentRun,
  AgentTicket,
  AutoQueueBoardEligibility,
  AutoQueueEligibilityResponse,
  CreateProjectInput,
  UpdateProjectInput,
  CreateTicketInput,
  DispatchPauseState,
  EpicSummary,
  QueueCriterion,
  RelationType,
  ResolvedRelation,
  SystemStatus,
  TicketEvent,
  TicketRelation,
  TicketSuggestion,
  ApproveSuggestionEdits,
  UpdateTicketInput,
  SurfaceTicketInput,
} from '@dashboard/shared';

export function projectIdColor(project: AgentProject | undefined | null): string {
  switch (project?.key) {
    case 'PD':
      return 'var(--accent)';
    case 'C':
      return '#0d9488';
    case 'NSW':
      return 'var(--accent-2)';
    default:
      return 'var(--muted)';
  }
}

const BASE = '/api/widgets/task-monitor/tickets';
const PROJECTS = '/api/widgets/task-monitor/projects';

/**
 * A failed request, keeping the server's machine-readable `code` and, for a Queue-gate refusal
 * (`409 QUEUE_GATE`, D-091), the criteria it was judged on, so the board can render the server's
 * answer instead of just its message (PD-633).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly blockers: QueueCriterion[] | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server's criteria when `e` is a Queue-gate refusal, otherwise null. */
export function queueGateBlockers(e: unknown): QueueCriterion[] | null {
  return e instanceof ApiError && e.code === 'QUEUE_GATE' ? e.blockers : null;
}

async function parseError(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  let code: string | null = null;
  let blockers: QueueCriterion[] | null = null;
  try {
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      blockers?: QueueCriterion[];
    };
    if (body.error) message = body.error;
    if (body.code) code = body.code;
    if (Array.isArray(body.blockers)) blockers = body.blockers;
  } catch {
    // non-JSON error body — keep the status text
  }
  throw new ApiError(message, res.status, code, blockers);
}

export async function fetchProjects(): Promise<AgentProject[]> {
  const res = await fetch(PROJECTS);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentProject[]>;
}

/** Create a project with a display-id prefix (`key`) and a linked GitHub repo (PD-284, slice 3). */
export async function createProject(input: CreateProjectInput): Promise<AgentProject> {
  const res = await fetch(PROJECTS, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentProject>;
}

/** Patch a project's mutable fields; the Projects page uses it for the "Include in Audit" toggle. */
export async function updateProject(
  id: number,
  patch: UpdateProjectInput,
): Promise<AgentProject> {
  const res = await fetch(`${PROJECTS}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentProject>;
}

export async function fetchTickets(): Promise<AgentTicket[]> {
  const res = await fetch(BASE);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket[]>;
}

/**
 * PD-611: "Add & keep running" — decline the pause that a membership change would otherwise trigger
 * on a refined, in-progress Epic. A write modifier, not a ticket field, which is why it rides
 * alongside the input rather than inside it (the server reads it off the raw body).
 *
 * The un-refine is never optional (D-089 §3); only the pause is.
 */
export interface EpicPauseOpts {
  keepEpicRunning?: boolean;
}

export async function createTicket(
  input: CreateTicketInput,
  opts: EpicPauseOpts = {},
): Promise<AgentTicket> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, ...opts }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

export async function updateTicket(
  id: number,
  patch: UpdateTicketInput,
  opts: EpicPauseOpts = {},
): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...patch, ...opts }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/**
 * Reopen a completed/closed Ticket (D-083, PD-542).
 *
 * Its own route rather than a status PATCH, which the server now refuses: reopening carries
 * obligations — the Ticket must land in an Epic, and its `agent_state` is cleared — and a plain
 * write is how a caller skips them. Pass `epicId` when the Ticket has none.
 */
/**
 * ✓ Mark refined (PD-610). Its own endpoint rather than `updateTicket({ refined: true })`, because
 * it carries obligations a generic field write cannot express — clear the staleness, and re-arm the
 * members a stale-pause un-armed. Approving an agent's proposal must not do the second thing.
 */
/** Switch an Epic in or out of the Refine backfill (PD-748); its members inherit it. */
export async function setBackfillExcluded(id: number, excluded: boolean): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/backfill-exclude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ excluded }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

export async function markRefined(id: number): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/mark-refined`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

export async function reopenTicket(id: number, epicId?: number): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(epicId === undefined ? {} : { epicId }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/** Archive a ticket. For an Epic (D-054), `cascadeMembers` archives its members too; otherwise
 *  they're unlinked and survive as free tickets. */
export async function deleteTicket(
  id: number,
  opts: { cascadeMembers?: boolean } = {},
): Promise<void> {
  const q = opts.cascadeMembers ? '?cascadeMembers=1' : '';
  const res = await fetch(`${BASE}/${id}${q}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) return parseError(res);
}

/** Reply to a parked agent (PD-250): posts a marked GitHub comment that re-queues it. */
export async function replyToTicket(id: number, body: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) return parseError(res);
}

/**
 * Start a Refine session on a ticket (D-044, PD-268). Writes the kickoff turn the agent-worker
 * picks up. Returns the created event, or throws (409 if a session is already running).
 *
 * `addedMemberId` (PD-996): the session follows a ticket joining this refined Epic, so the kickoff
 * asks only what that ticket changes, and continues the Epic's thread if it already has one.
 */
export async function startRefine(id: number, opts: { addedMemberId?: number } = {}): Promise<TicketEvent> {
  const res =
    opts.addedMemberId === undefined
      ? await fetch(`${BASE}/${id}/refine`, { method: 'POST' })
      : await fetch(`${BASE}/${id}/refine`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addedMemberId: opts.addedMemberId }),
        });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketEvent>;
}

/** A ticket's activity log — the generic substrate the Refine thread + activity timeline render. */
export async function fetchTicketEvents(id: number): Promise<TicketEvent[]> {
  const res = await fetch(`${BASE}/${id}/events`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketEvent[]>;
}

/** A ticket's Robot run history — one row per attempt, newest first (C3/PD-344). */
export async function fetchTicketRuns(id: number): Promise<AgentRun[]> {
  const res = await fetch(`${BASE}/${id}/runs`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentRun[]>;
}

/** The board's Site Status snapshot — Robot fleet + worker liveness + Robot dispatch state. */
export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await fetch('/api/widgets/task-monitor/system-status');
  if (!res.ok) return parseError(res);
  return res.json() as Promise<SystemStatus>;
}

// ── Robot remediation (C4/PD-345) — plain DB writes the loop honors on its next poll. ──

/** Clear a ticket's transient-retry budget and re-dispatch it (for a capped/backing-off ticket). */
export async function resetTicketRuns(id: number): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/robot/reset`, { method: 'POST' });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/** Unstick a parked ticket (stuck / awaiting-human): clear the park + re-queue it. */
export async function unstickTicket(id: number): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/robot/unstick`, { method: 'POST' });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/** D-094/PD-737: Continue a checkpointed ticket from its saved work. PD-964 (D-114): a fresh episode —
 *  progress-checked every window up to the total cap — so it takes no turn count. */
export async function continueTicket(id: number): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/robot/continue`, { method: 'POST' });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/** D-094/PD-737: Restart a checkpointed ticket — a fresh run from main. */
export async function restartTicket(id: number): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}/robot/restart`, { method: 'POST' });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/** Globally pause Robot dispatch (loop-wide). */
export async function pauseDispatch(reason?: string): Promise<DispatchPauseState> {
  const res = await fetch('/api/widgets/task-monitor/robot/pause', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<DispatchPauseState>;
}

/** Resume Robot dispatch — clears a manual pause or a system-wide fault pause (C2). */
export async function resumeDispatch(): Promise<DispatchPauseState> {
  const res = await fetch('/api/widgets/task-monitor/robot/resume', { method: 'POST' });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<DispatchPauseState>;
}

/**
 * Post a human Refine reply (PD-267). Unlike replyToTicket, this stays in the DB: it writes
 * a refine_human event the agent-worker consumes and resumes on. Returns the created event.
 */
export async function postRefineReply(id: number, body: string): Promise<TicketEvent> {
  const res = await fetch(`${BASE}/${id}/refine-reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketEvent>;
}

/** Approve the latest Refine commit proposal (PD-269, D-057): the server refines-in-place or
 *  decomposes and marks refined, but never dispatches. Pass `queue: true` (the "Approve & queue"
 *  button — non-Epic refine_in_place only) to also move the ticket into `queue`. Throws on
 *  409 (no proposal / Epic can't queue / blocked) / 422 (invalid proposal). Resolves with
 *  `{ queued, populated }` — `populated` is true when a decompose on an Epic was reinterpreted as
 *  Populate (members created, Epic left open; D-058). */
export async function approveRefine(
  id: number,
  opts: { queue?: boolean } = {},
): Promise<{ queued: boolean; populated: boolean }> {
  const res = await fetch(`${BASE}/${id}/refine-approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queue: opts.queue === true }),
  });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { queued?: boolean; populated?: boolean };
  return { queued: body.queued === true, populated: body.populated === true };
}

/** Answer the open Refine question round with structured answers (PD-744/PD-745). The server
 *  validates them against the round and writes the rendered text the agent reads. Throws on 409
 *  (no open round — e.g. already answered in another tab) / 400 (invalid answers). */
export async function postRefineAnswers(id: number, answers: RefineAnswerSet): Promise<TicketEvent> {
  const res = await fetch(`${BASE}/${id}/refine-reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(answers),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketEvent>;
}

/** Every Refine session waiting on Steve, with its latest round (PD-746, the Decisions inbox). */
/** Robot PRs waiting for Steve's visual check (PD-773). */
export async function fetchAwaitingVisual(): Promise<{ items: AwaitingVisualItem[]; count: number }> {
  const res = await fetch('/api/widgets/task-monitor/visual-review/awaiting');
  if (!res.ok) return parseError(res);
  return res.json() as Promise<{ items: AwaitingVisualItem[]; count: number }>;
}

/** Steve's visual verdict on a ticket's PR (PD-773). A rejection needs a note. Throws on 4xx. */
export async function postVisualReview(id: number, approved: boolean, note = ''): Promise<void> {
  const res = await fetch(`${BASE}/${id}/visual-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved, note }),
  });
  if (!res.ok) return parseError(res);
}

/** PD-979 (D-119): Ticket Suggestions — the Evaluator's leftover findings, pending + recently
 *  decided. `count` is the pending total that feeds the Decisions badge. */
export async function fetchTicketSuggestions(): Promise<{ items: TicketSuggestion[]; count: number }> {
  const res = await fetch('/api/widgets/task-monitor/ticket-suggestions');
  if (!res.ok) return parseError(res);
  return res.json() as Promise<{ items: TicketSuggestion[]; count: number }>;
}

/** Approve a suggestion, with optional Modify edits; creates a backlog ticket. Throws on 4xx. */
export async function approveTicketSuggestion(
  id: number,
  edits: ApproveSuggestionEdits = {},
): Promise<TicketSuggestion> {
  const res = await fetch(`/api/widgets/task-monitor/ticket-suggestions/${id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edits),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketSuggestion>;
}

/** Reject a suggestion, with an optional reason. Throws on 4xx. */
export async function rejectTicketSuggestion(id: number, reason = ''): Promise<TicketSuggestion> {
  const res = await fetch(`/api/widgets/task-monitor/ticket-suggestions/${id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketSuggestion>;
}

export async function fetchAwaitingRefine(): Promise<{ items: AwaitingRefineItem[]; count: number }> {
  const res = await fetch('/api/widgets/task-monitor/refine/awaiting');
  if (!res.ok) return parseError(res);
  return res.json() as Promise<{ items: AwaitingRefineItem[]; count: number }>;
}

/** Park the Refine session (PD-743, D-096): end it without a commit. A later reply reopens it.
 *  Throws on 409 (no session / already ended). */
export async function parkRefine(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}/refine-park`, { method: 'POST' });
  if (!res.ok) return parseError(res);
}

/** Reject the latest Refine commit proposal (PD-269); the refine session can propose again. */
export async function rejectRefine(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}/refine-reject`, { method: 'POST' });
  if (!res.ok) return parseError(res);
}

/** Every relation touching a ticket, both directions, resolved to the other end (PD-321). The
 *  detail page derives its split-lineage subset client-side by filtering `type === 'split'`. */
export async function fetchRelations(id: number): Promise<ResolvedRelation[]> {
  const res = await fetch(`${BASE}/${id}/relations`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<ResolvedRelation[]>;
}

/** D-103 (PD-809): would the auto-queue promoter queue this ticket, and if not, why? The criteria
 *  (or, on an Epic, its Epic-level criteria + per-member verdicts), the capacity snapshot and the
 *  promoter's run mode — what the detail-page checklist renders. */
export async function fetchQueueEligibility(id: number): Promise<AutoQueueEligibilityResponse> {
  const res = await fetch(`${BASE}/${id}/queue-eligibility`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AutoQueueEligibilityResponse>;
}

/** D-103 (PD-810): every live Backlog ticket's auto-queue eligibility in one read — the board's
 *  Eligible view and each card's "eligible" badge derive from this, the same bulk-over-per-card
 *  pattern as `fetchAllRelations`. Carries the board-wide capacity snapshot + each Epic's in-flight
 *  count so a card's capacity-wait note is computable client-side without a per-card round-trip. */
export async function fetchBoardEligibility(): Promise<AutoQueueBoardEligibility> {
  const res = await fetch(`/api/widgets/task-monitor/queue-eligibility`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AutoQueueBoardEligibility>;
}

/** Every relation on the board as raw rows (PD-322) — one fetch for all card badges. */
export async function fetchAllRelations(): Promise<TicketRelation[]> {
  const res = await fetch(`/api/widgets/task-monitor/relations`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<TicketRelation[]>;
}

/** Every live Epic's roll-up + derived lane (D-054, PD-337) — one fetch to place Epic cards. */
export async function fetchEpicSummaries(): Promise<EpicSummary[]> {
  const res = await fetch(`/api/widgets/task-monitor/epics`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<EpicSummary[]>;
}

/** An Epic's member Tickets + its roll-up (D-054, PD-338) — the Epic detail page's list. */
export async function fetchEpicMembers(
  id: number,
): Promise<{ members: AgentTicket[]; summary: EpicSummary }> {
  const res = await fetch(`${BASE}/${id}/members`);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<{ members: AgentTicket[]; summary: EpicSummary }>;
}

/** Create a relation from the UI (origin='human'). `fromId` is the source (for `blocks`, the
 *  blocker); `toId` the target (the blocked). Throws on 400 self / 409 cycle. */
export async function createRelation(
  ticketId: number,
  fromId: number,
  toId: number,
  type: RelationType,
): Promise<ResolvedRelation> {
  const res = await fetch(`${BASE}/${ticketId}/relations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromId, toId, type }),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<ResolvedRelation>;
}

/** Remove a relation by its row id (the detail-page per-row remove). */
export async function deleteRelation(ticketId: number, relationId: number): Promise<void> {
  const res = await fetch(`${BASE}/${ticketId}/relations/${relationId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) return parseError(res);
}

/**
 * File a suggestion ticket from a widget card's +, a page's footer, or the app-wide nav button.
 * The server picks the Epic (the triage inbox) and shapes title + provenance from the surface;
 * `refine: true` also opens a Refine session on it.
 */
export async function fileSurfaceTicket(
  input: SurfaceTicketInput,
): Promise<{ ticket: AgentTicket; refineStarted: boolean }> {
  const res = await fetch('/api/widgets/task-monitor/surface-tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<{ ticket: AgentTicket; refineStarted: boolean }>;
}
