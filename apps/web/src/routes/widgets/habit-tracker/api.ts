import type {
  HabitChoiceOption,
  HabitCompletion,
  HabitItemView,
  HabitMetricType,
  HabitMetricValue,
  HabitSchedule,
  HabitSettings,
  HabitTodayView,
  SetHabitScheduleInput,
} from '@dashboard/shared';

/**
 * Typed fetch wrappers for the shared habit store (PD-721, D-092).
 *
 * The store is core infrastructure, so the routes live at `/api/habits/...`, not under
 * `/api/widgets/...`.
 *
 * Writes that go through the offline outbox (completions and metric values; this ticket) need the
 * outbox's reachable-vs-refused distinction, so those requests throw {@link UnreachableError} (keep
 * queued, retry) or {@link RejectedError} (4xx, drop — a retry fails the same way), mirroring the
 * Tinnitus Tracker's api.
 */

const BASE = '/api/habits';

/**
 * The server couldn't be reached, or answered with a 5xx (which includes the tailnet proxy failing
 * to reach the NAS). Worth retrying later — the offline outbox keeps such writes queued.
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

const withBody = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function fetchItems(includeArchived = false): Promise<HabitItemView[]> {
  const q = includeArchived ? '?includeArchived=1' : '';
  return (await request<{ items: HabitItemView[] }>(`/items${q}`)).items;
}

export function createItem(name: string): Promise<HabitItemView> {
  return request<HabitItemView>('/items', withBody('POST', { name }));
}

/** Create a metric (kind `metric`) of the given type (PD-724). */
export function createMetric(name: string, metricType: HabitMetricType): Promise<HabitItemView> {
  return request<HabitItemView>('/items', withBody('POST', { name, kind: 'metric', metricType }));
}

/** Change a metric's type. The server refuses (RejectedError) once the metric has any value. */
export function setMetricType(id: number, metricType: HabitMetricType): Promise<HabitItemView> {
  return request<HabitItemView>(`/items/${id}/metric-type`, withBody('PUT', { metricType }));
}

export function renameItem(id: number, name: string): Promise<HabitItemView> {
  return request<HabitItemView>(`/items/${id}`, withBody('PATCH', { name }));
}

export async function reorderItems(ids: number[]): Promise<HabitItemView[]> {
  return (await request<{ items: HabitItemView[] }>('/items/reorder', withBody('PUT', { ids }))).items;
}

/**
 * Move an item into / out of a set (PD-723). `parentId` null moves it to the top level; `siblingIds`
 * is the destination group's new order. The server rejects cycles.
 */
export async function moveItem(
  itemId: number,
  parentId: number | null,
  siblingIds: number[],
): Promise<HabitItemView[]> {
  return (
    await request<{ items: HabitItemView[] }>(`/items/${itemId}/move`, withBody('PUT', { parentId, siblingIds }))
  ).items;
}

export function setArchived(id: number, archived: boolean): Promise<HabitItemView> {
  return request<HabitItemView>(`/items/${id}/archive`, withBody('POST', { archived }));
}

export function deleteItem(id: number): Promise<{ completionCount: number }> {
  return request<{ completionCount: number }>(`/items/${id}`, withBody('DELETE'));
}

export async function fetchCompletions(from: string, to: string): Promise<HabitCompletion[]> {
  const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return (await request<{ completions: HabitCompletion[] }>(`/completions${q}`)).completions;
}

/**
 * Set whether `itemId` is done on habit day `day` (idempotent set-state — the outbox replays it).
 * Throws {@link UnreachableError} / {@link RejectedError} so the outbox can keep-or-drop the write.
 */
export function setCompletion(
  itemId: number,
  day: string,
  done: boolean,
): Promise<{ completion: HabitCompletion | null }> {
  return request<{ completion: HabitCompletion | null }>('/completions', withBody('PUT', { itemId, day, done }));
}

/**
 * The server-computed Today view. `day` views a past habit day instead of the current one (PD-779
 * ([Habit Tracker] date header + day arrows on Today)); the server clamps a future day to today and
 * the returned view's `day` says which day it served.
 */
export function fetchToday(day?: string): Promise<HabitTodayView> {
  return request<HabitTodayView>(day ? `/today?day=${encodeURIComponent(day)}` : '/today');
}

export async function fetchSchedules(): Promise<HabitSchedule[]> {
  return (await request<{ schedules: HabitSchedule[] }>('/schedules')).schedules;
}

export function setSchedule(id: number, input: SetHabitScheduleInput): Promise<HabitSchedule> {
  return request<HabitSchedule>(`/items/${id}/schedule`, withBody('PUT', input));
}

/**
 * Set metric `itemId`'s value on habit day `day` (`null` clears it). An idempotent set-state write,
 * keyed on `(item, day)` like a completion (PROJECT.md §4), so it rides the same offline outbox.
 *
 * The metric store, its `PUT /api/habits/metric-values` route and the metric UI are later slices
 * (PD-724 and the Log views PD-725/PD-726); this wrapper + the outbox dispatch are in place so the
 * write path is uniform the moment those land. Shape follows the `habit_metric_values` sketch in
 * `widgets/habit-tracker/PROJECT.md` §5.
 */
export function setMetricValue(itemId: number, day: string, value: string | null): Promise<void> {
  return request<void>('/metric-values', withBody('PUT', { itemId, day, value }));
}

export async function fetchMetricValues(from: string, to: string): Promise<HabitMetricValue[]> {
  const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return (await request<{ values: HabitMetricValue[] }>(`/metric-values${q}`)).values;
}

export async function fetchChoiceOptions(itemId: number, includeArchived = false): Promise<HabitChoiceOption[]> {
  const q = includeArchived ? '?includeArchived=1' : '';
  return (await request<{ options: HabitChoiceOption[] }>(`/items/${itemId}/options${q}`)).options;
}

export function createChoiceOption(itemId: number, label: string): Promise<HabitChoiceOption> {
  return request<HabitChoiceOption>(`/items/${itemId}/options`, withBody('POST', { label }));
}

export function renameChoiceOption(optionId: number, label: string): Promise<HabitChoiceOption> {
  return request<HabitChoiceOption>(`/options/${optionId}`, withBody('PATCH', { label }));
}

export function setChoiceOptionArchived(optionId: number, archived: boolean): Promise<HabitChoiceOption> {
  return request<HabitChoiceOption>(`/options/${optionId}/archive`, withBody('POST', { archived }));
}

export function deleteChoiceOption(optionId: number): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/options/${optionId}`, withBody('DELETE'));
}

export function fetchSettings(): Promise<HabitSettings> {
  return request<HabitSettings>('/settings');
}

export function patchSettings(input: Partial<HabitSettings>): Promise<HabitSettings> {
  return request<HabitSettings>('/settings', withBody('PATCH', input));
}
