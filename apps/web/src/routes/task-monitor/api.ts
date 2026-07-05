import type { AgentProject, AgentTicket, CreateTicketInput, UpdateTicketInput } from '@dashboard/shared';

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

const BASE = '/api/widgets/agent-dashboard/tickets';
const PROJECTS = '/api/widgets/agent-dashboard/projects';
const SYNC = '/api/widgets/agent-dashboard/sync';

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

export async function deleteTicket(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' });
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
