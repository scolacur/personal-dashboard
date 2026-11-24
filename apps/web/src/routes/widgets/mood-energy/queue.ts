import type { SaveMoodEnergyEntryInput } from '@dashboard/shared';

/**
 * Mood & Energy payload concerns for the shared offline outbox (`$lib/outbox`, D-093). Every save —
 * the capture and the calendar's edit dialog — is a `POST /entries` upsert queued here.
 */

/** The storage key for pending saves. Keep it stable, or saves queued on a phone are orphaned. */
export const QUEUE_KEY = 'mood-energy:pending';

export type PendingSave = SaveMoodEnergyEntryInput;

/**
 * A unique id for a save. `crypto.randomUUID` only exists in a secure context, and the dashboard is
 * served over plain http on the LAN and tailnet, so this falls back to time plus randomness.
 */
export function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
