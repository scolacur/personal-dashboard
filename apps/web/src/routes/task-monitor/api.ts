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
