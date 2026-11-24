import type {
  HabitSettings,
  MoodEnergyEntry,
  MoodEnergyTag,
  SaveMoodEnergyEntryInput,
  UpdateMoodEnergyEntryInput,
} from '@dashboard/shared';

const BASE = '/api/widgets/mood-energy';
/** The Habit Tracker's settings route: its day boundary and timezone define a Mood & Energy day. */
const HABIT_SETTINGS_URL = '/api/habits/settings';

/** The server couldn't be reached, or answered 5xx. Worth retrying later; the outbox keys on this. */
export class UnreachableError extends Error {}

/** The server reached a verdict and said no (4xx). Retrying the same request won't help. */
export class RejectedError extends Error {}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
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

export function fetchHabitSettings(): Promise<HabitSettings> {
  return request<HabitSettings>(HABIT_SETTINGS_URL);
}

export async function fetchTags(): Promise<MoodEnergyTag[]> {
  return (await request<{ tags: MoodEnergyTag[] }>(`${BASE}/tags`)).tags;
}

export function createTag(name: string): Promise<MoodEnergyTag> {
  return request<MoodEnergyTag>(`${BASE}/tags`, withBody('POST', { name }));
}

export function hideTag(id: number): Promise<void> {
  return request<void>(`${BASE}/tags/${id}`, { method: 'DELETE' });
}

/** Newest day first. `since` / `until` are habit days, inclusive. */
export async function fetchEntries(opts: { since?: string; until?: string; limit?: number } = {}): Promise<MoodEnergyEntry[]> {
  const q = new URLSearchParams();
  if (opts.since) q.set('since', opts.since);
  if (opts.until) q.set('until', opts.until);
  if (opts.limit) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return (await request<{ entries: MoodEnergyEntry[] }>(`${BASE}/entries${qs ? `?${qs}` : ''}`)).entries;
}

export async function fetchEntryForDay(day: string): Promise<MoodEnergyEntry | null> {
  return (await request<{ entry: MoodEnergyEntry | null }>(`${BASE}/entries/day/${day}`)).entry;
}

/** Upsert by day; idempotent on `clientId`. Every capture goes through the outbox, which calls this. */
export function saveEntry(input: SaveMoodEnergyEntryInput): Promise<MoodEnergyEntry> {
  return request<MoodEnergyEntry>(`${BASE}/entries`, withBody('POST', input));
}

export function updateEntry(id: number, input: UpdateMoodEnergyEntryInput): Promise<MoodEnergyEntry> {
  return request<MoodEnergyEntry>(`${BASE}/entries/${id}`, withBody('PATCH', input));
}

export function deleteEntry(id: number): Promise<void> {
  return request<void>(`${BASE}/entries/${id}`, { method: 'DELETE' });
}
