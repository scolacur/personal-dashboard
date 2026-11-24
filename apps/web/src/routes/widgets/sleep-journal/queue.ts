import type { CreateSleepEntryInput } from '@dashboard/shared';

/**
 * Sleep-Journal-specific payload concerns for the offline outbox (`$lib/outbox`): the storage key,
 * the payload type, and the client id the server dedupes replays on.
 */

/** Keep stable: nights already queued on a phone are stored under it. */
export const QUEUE_KEY = 'sleep-journal:pending';

export type PendingNight = CreateSleepEntryInput;

/**
 * A unique id for a save. `crypto.randomUUID` only exists in a secure context, and the dashboard
 * is served over plain http on the LAN and tailnet, so this falls back to time plus randomness.
 */
export function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
