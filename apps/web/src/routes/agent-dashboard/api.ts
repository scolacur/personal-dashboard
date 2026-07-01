import type { AgentProject, AgentTodo, CreateTodoInput, UpdateTodoInput } from '@dashboard/shared';

const BASE = '/api/widgets/agent-dashboard/todos';
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

export async function fetchTodos(): Promise<AgentTodo[]> {
  const res = await fetch(BASE);
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTodo[]>;
}

export async function createTodo(input: CreateTodoInput): Promise<AgentTodo> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTodo>;
}

export async function updateTodo(id: number, patch: UpdateTodoInput): Promise<AgentTodo> {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return parseError(res);
  return res.json() as Promise<AgentTodo>;
}

export async function deleteTodo(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) return parseError(res);
}
