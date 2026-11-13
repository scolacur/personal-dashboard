import type {
  CreateTinnitusEntryInput,
  TinnitusEntry,
  TinnitusTag,
  UpdateTinnitusEntryInput,
} from '@dashboard/shared';

const BASE = '/api/widgets/tinnitus-tracker';

/**
 * The server couldn't be reached, or answered with a 5xx (which includes the tailnet proxy failing
 * to reach the NAS). Worth retrying later. The offline queue keys on this.
 */
export class UnreachableError extends Error {}

/** The server reached a verdict and said no (4xx). Retrying the same request won't help. */
export class RejectedError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new UnreachableError('Server unreachable.');
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  const message = body.error ?? `Request failed (${res.status})`;
  throw res.status >= 500 ? new UnreachableError(message) : new RejectedError(message);
}

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function fetchTags(): Promise<TinnitusTag[]> {
  return (await request<{ tags: TinnitusTag[] }>('/tags')).tags;
}

export function createTag(name: string): Promise<TinnitusTag> {
  return request<TinnitusTag>('/tags', withBody('POST', { name }));
}

export function hideTag(id: number): Promise<void> {
  return request<void>(`/tags/${id}`, { method: 'DELETE' });
}

export async function fetchEntries(limit = 50): Promise<TinnitusEntry[]> {
  return (await request<{ entries: TinnitusEntry[] }>(`/entries?limit=${limit}`)).entries;
}

/** Every entry at or after `since` (unix ms), newest first. For the Trends tab. */
export async function fetchEntriesSince(since: number): Promise<TinnitusEntry[]> {
  return (await request<{ entries: TinnitusEntry[] }>(`/entries?since=${since}`)).entries;
}

export function createEntry(input: CreateTinnitusEntryInput): Promise<TinnitusEntry> {
  return request<TinnitusEntry>('/entries', withBody('POST', input));
}

export function updateEntry(id: number, input: UpdateTinnitusEntryInput): Promise<TinnitusEntry> {
  return request<TinnitusEntry>(`/entries/${id}`, withBody('PATCH', input));
}

export function deleteEntry(id: number): Promise<void> {
  return request<void>(`/entries/${id}`, { method: 'DELETE' });
}
