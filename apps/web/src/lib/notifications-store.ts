import { writable } from 'svelte/store';
import { fetchUnreadCount } from './notifications-api';

// Single source of truth for the unread badge, shared across the nav bell and the
// /notifications page so a mark-read from anywhere updates the bell immediately.
export const unreadCount = writable(0);

/** Re-fetch the unread count and publish it to the store. Best-effort. */
export async function refreshUnreadCount(): Promise<void> {
  try {
    unreadCount.set(await fetchUnreadCount());
  } catch {
    // transient — keep the last known count
  }
}
