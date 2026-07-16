import type {
  AgentProject,
  AgentRun,
  AgentTicket,
  CreateTicketInput,
  EpicSummary,
  RelationType,
  ResolvedRelation,
  SystemStatus,
  TicketEvent,
  TicketRelation,
  UpdateTicketInput,
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
const SYNC = '/api/widgets/task-monitor/sync';

async function parseError(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // non-JSON error body — keep the status text
  }
  throw new Error(message);
}

export async function fetchProjects(): Promise<AgentProject[]> {
  const res = await fetch(PROJECTS);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentProject[]>;
}

export async function fetchTickets(): Promise<AgentTicket[]> {
  const res = await fetch(BASE);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket[]>;
}

/**
 * Trigger an immediate server→GitHub reconciliation (PD-252). Resolves once the pass (if one
 * ran) has landed in the DB, so the caller can then re-fetch fresh tickets. Server-side
 * guarded/coalesced, so calling it on mount or via the button never hammers GitHub. A 503
 * (no read token configured, e.g. in dev) is swallowed — the board still shows current data.
 */
export async function syncNow(): Promise<void> {
  const res = await fetch(SYNC, { method: 'POST' });
  if (!res.ok && res.status !== 503) return parseError(res);
}

export async function createTicket(input: CreateTicketInput): Promise<AgentTicket> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

export async function updateTicket(id: number, patch: UpdateTicketInput): Promise<AgentTicket> {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTicket>;
}

/** Archive a ticket. For an Epic (D-054), `cascadeMembers` archives its members too; otherwise
 *  they're unlinked and survive as free tickets. */
export async function deleteTicket(id: number, opts: { cascadeMembers?: boolean } = {}): Promise<void> {
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
 */
export async function startRefine(id: number): Promise<TicketEvent> {
  const res = await fetch(`${BASE}/${id}/refine`, { method: 'POST' });
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

/** The board's Site Status snapshot — Sortie fleet + worker liveness + Robot dispatch state. */
export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await fetch('/api/widgets/task-monitor/system-status');
  if (!res.ok) return parseError(res);
  return res.json() as Promise<SystemStatus>;
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

/** Approve the latest Refine commit proposal (PD-269): the server refines-in-place or
 *  decomposes. Throws on 409 (no proposal) / 422 (a robot child isn't Sortie-ready). */
export async function approveRefine(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}/refine-approve`, { method: 'POST' });
  if (!res.ok) return parseError(res);
}

/** Reject the latest Refine commit proposal (PD-269); the grill can propose again. */
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
