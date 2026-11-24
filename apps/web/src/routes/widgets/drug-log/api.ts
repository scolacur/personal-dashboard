import type {
  CreateDrugLogDrugInput,
  CreateDrugLogEventInput,
  DrugLogDrug,
  DrugLogDrugsResponse,
  DrugLogEvent,
  UpdateDrugLogDrugInput,
  UpdateDrugLogEventInput,
} from '@dashboard/shared';

const BASE = '/api/widgets/drug-log';

/** Couldn't reach the server, or a 5xx. Worth retrying later; the outbox keeps the tap. */
export class UnreachableError extends Error {}

/** The server said no (4xx). Retrying won't help; the outbox drops it. */
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

/** Every drug (archived included) and the habit-day settings to bucket events by. */
export function fetchDrugs(): Promise<DrugLogDrugsResponse> {
  return request<DrugLogDrugsResponse>('/drugs');
}

export function createDrug(input: CreateDrugLogDrugInput): Promise<DrugLogDrug> {
  return request<DrugLogDrug>('/drugs', withBody('POST', input));
}

export function updateDrug(id: number, input: UpdateDrugLogDrugInput): Promise<DrugLogDrug> {
  return request<DrugLogDrug>(`/drugs/${id}`, withBody('PATCH', input));
}

export function deleteDrug(id: number): Promise<void> {
  return request<void>(`/drugs/${id}`, { method: 'DELETE' });
}

export interface EventQuery {
  since?: number;
  until?: number;
  drugId?: number;
  limit?: number;
}

export async function fetchEvents(q: EventQuery = {}): Promise<DrugLogEvent[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return (await request<{ events: DrugLogEvent[] }>(`/events${qs ? `?${qs}` : ''}`)).events;
}

export function createEvent(input: CreateDrugLogEventInput): Promise<DrugLogEvent> {
  return request<DrugLogEvent>('/events', withBody('POST', input));
}

export function updateEvent(id: number, input: UpdateDrugLogEventInput): Promise<DrugLogEvent> {
  return request<DrugLogEvent>(`/events/${id}`, withBody('PATCH', input));
}

export function deleteEvent(id: number): Promise<void> {
  return request<void>(`/events/${id}`, { method: 'DELETE' });
}
