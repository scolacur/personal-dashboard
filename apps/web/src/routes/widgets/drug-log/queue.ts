import type { CreateDrugLogEventInput } from '@dashboard/shared';

/**
 * Drug Log payload concerns for the generic `$lib/outbox` (PD-975, Drug log widget): the storage
 * key, the payload type and the client id the server dedupes taps on.
 */

/** Keep stable across deploys, or taps queued on a phone are orphaned. */
export const QUEUE_KEY = 'drug-log:pending';

export type PendingTap = CreateDrugLogEventInput;

/**
 * A unique id for a tap. `crypto.randomUUID` only exists in a secure context, and the dashboard is
 * served over plain http on the LAN and tailnet, so this falls back to time plus randomness.
 */
export function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}
