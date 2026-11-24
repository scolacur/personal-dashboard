import type { CreateSleepEntryInput, SleepEntry, SleepTag, UpdateSleepEntryInput } from '@dashboard/shared';

const BASE = '/api/widgets/sleep-journal';

/**
 * The server couldn't be reached, or answered with a 5xx (which includes the tailnet proxy failing
 * to reach the NAS). Worth retrying later. The offline outbox keys on this.
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

export async function fetchTags(): Promise<SleepTag[]> {
  return (await request<{ tags: SleepTag[] }>('/tags')).tags;
}

export function createTag(name: string): Promise<SleepTag> {
  return request<SleepTag>('/tags', withBody('POST', { name }));
}

export function hideTag(id: number): Promise<void> {
  return request<void>(`/tags/${id}`, { method: 'DELETE' });
}

/** The most recent nights, newest first. */
export async function fetchEntries(limit = 50): Promise<SleepEntry[]> {
  return (await request<{ entries: SleepEntry[] }>(`/entries?limit=${limit}`)).entries;
}

/** Every night whose wake date is on or after `since` (`YYYY-MM-DD`), newest first. */
export async function fetchEntriesSince(since: string): Promise<SleepEntry[]> {
  return (await request<{ entries: SleepEntry[] }>(`/entries?since=${since}`)).entries;
}

/** Creates the night, or updates the one already on its wake date. */
export function createEntry(input: CreateSleepEntryInput): Promise<SleepEntry> {
  return request<SleepEntry>('/entries', withBody('POST', input));
}

export function updateEntry(id: number, input: UpdateSleepEntryInput): Promise<SleepEntry> {
  return request<SleepEntry>(`/entries/${id}`, withBody('PATCH', input));
}

export function deleteEntry(id: number): Promise<void> {
  return request<void>(`/entries/${id}`, { method: 'DELETE' });
}
