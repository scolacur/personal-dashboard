import type { AgentNotification } from '@dashboard/shared';

// Notification Center API client (D-040 / PD-250). Lives in $lib because the bell is
// mounted in the app-wide top nav, not inside the task-monitor route.
const BASE = '/api/widgets/agent-dashboard/notifications';

export async function fetchNotifications(
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<AgentNotification[]> {
  const params = new URLSearchParams();
  if (opts.unreadOnly) params.set('unread', '1');
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await fetch(qs ? `${BASE}?${qs}` : BASE);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<AgentNotification[]>;
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await fetch(`${BASE}/unread-count`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { count: number };
  return body.count;
}

export async function markNotificationRead(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}/read`, { method: 'POST' });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status} ${res.statusText}`);
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await fetch(`${BASE}/read-all`, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}
