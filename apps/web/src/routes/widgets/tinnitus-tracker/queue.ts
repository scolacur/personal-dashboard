import type { CreateTinnitusEntryInput } from '@dashboard/shared';

/**
 * Tinnitus-specific payload concerns for the offline outbox.
 *
 * The outbox mechanics — localStorage persistence, the flush loop, the retry triggers and the
 * pending count — moved to the generic `$lib/outbox` so the Habit Tracker can share them (PD-736).
 * What stays here is what's specific to a Tinnitus entry: its payload type and the client id the
 * server dedupes on.
 */

/** The storage key for pending Tinnitus entries. Kept stable so entries already queued on a phone survive the move to `$lib/outbox`. */
export const QUEUE_KEY = 'tinnitus-tracker:pending';

export type PendingEntry = CreateTinnitusEntryInput;

/**
 * A unique id for an entry. `crypto.randomUUID` only exists in a secure context, and the dashboard
 * is served over plain http on the LAN and tailnet. On a phone it is often undefined, so this falls
 * back to time plus randomness, which is plenty for one person's log.
 */
export function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
