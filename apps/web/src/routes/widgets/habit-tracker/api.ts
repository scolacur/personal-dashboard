import type { HabitCompletion, HabitItemView, HabitSettings } from '@dashboard/shared';

/**
 * Typed fetch wrappers for the shared habit store (PD-721, D-092).
 *
 * The store is core infrastructure, so the routes live at `/api/habits/...`, not under
 * `/api/widgets/...`. No offline outbox yet — that is lifted in for all widgets in PD-728/PD-729;
 * this tracer talks to the server directly.
 */

const BASE = '/api/habits';

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `Request failed (${res.status})`);
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function fetchItems(includeArchived = false): Promise<HabitItemView[]> {
  const q = includeArchived ? '?includeArchived=1' : '';
  return (await json<{ items: HabitItemView[] }>(await fetch(`${BASE}/items${q}`))).items;
}

export async function createItem(name: string): Promise<HabitItemView> {
  return json<HabitItemView>(await fetch(`${BASE}/items`, send('POST', { name })));
}

export async function renameItem(id: number, name: string): Promise<HabitItemView> {
  return json<HabitItemView>(await fetch(`${BASE}/items/${id}`, send('PATCH', { name })));
}

export async function reorderItems(ids: number[]): Promise<HabitItemView[]> {
  return (await json<{ items: HabitItemView[] }>(await fetch(`${BASE}/items/reorder`, send('PUT', { ids }))))
    .items;
}

export async function setArchived(id: number, archived: boolean): Promise<HabitItemView> {
  return json<HabitItemView>(await fetch(`${BASE}/items/${id}/archive`, send('POST', { archived })));
}

export async function deleteItem(id: number): Promise<{ completionCount: number }> {
  return json<{ completionCount: number }>(await fetch(`${BASE}/items/${id}`, send('DELETE')));
}

export async function fetchCompletions(from: string, to: string): Promise<HabitCompletion[]> {
  const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return (await json<{ completions: HabitCompletion[] }>(await fetch(`${BASE}/completions${q}`))).completions;
}

export async function setCompletion(
  itemId: number,
  day: string,
  done: boolean,
): Promise<{ completion: HabitCompletion | null }> {
  return json<{ completion: HabitCompletion | null }>(
    await fetch(`${BASE}/completions`, send('PUT', { itemId, day, done })),
  );
}

export async function fetchSettings(): Promise<HabitSettings> {
  return json<HabitSettings>(await fetch(`${BASE}/settings`));
}

export async function patchSettings(input: Partial<HabitSettings>): Promise<HabitSettings> {
  return json<HabitSettings>(await fetch(`${BASE}/settings`, send('PATCH', input)));
}
