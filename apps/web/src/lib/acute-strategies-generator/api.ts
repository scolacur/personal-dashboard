import type { AcuteStrategyIdea, CreateIdeaInput, IdeaType, UpdateIdeaInput } from '@dashboard/shared';

const BASE = '/api/widgets/acute-strategies-generator';

export async function fetchIdeas(opts?: { type?: IdeaType; tag?: string }): Promise<AcuteStrategyIdea[]> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.tag) params.set('tag', opts.tag);
  const qs = params.toString();
  const res = await fetch(`${BASE}/ideas${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error('Failed to load ideas');
  return res.json() as Promise<AcuteStrategyIdea[]>;
}

export async function createIdea(input: CreateIdeaInput): Promise<AcuteStrategyIdea> {
  const res = await fetch(`${BASE}/ideas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to create idea');
  return res.json() as Promise<AcuteStrategyIdea>;
}

export async function updateIdea(id: number, input: UpdateIdeaInput): Promise<AcuteStrategyIdea> {
  const res = await fetch(`${BASE}/ideas/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to update idea');
  return res.json() as Promise<AcuteStrategyIdea>;
}

export async function deleteIdea(id: number): Promise<void> {
  const res = await fetch(`${BASE}/ideas/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete idea');
}
