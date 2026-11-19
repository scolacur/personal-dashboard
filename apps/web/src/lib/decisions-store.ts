import { writable } from 'svelte/store';
import { fetchAwaitingRefine } from '../routes/devops/api';

// How many Refine sessions are waiting on Steve — the Decisions nav badge (PD-746). One store so
// the badge and the Decisions page agree, and an answer sent from the page updates the badge
// without waiting for the next poll.
export const decisionsCount = writable(0);

/** Re-fetch the count and publish it. Best-effort: a failed poll keeps the last known count. */
export async function refreshDecisionsCount(): Promise<void> {
  try {
    decisionsCount.set((await fetchAwaitingRefine()).count);
  } catch {
    // transient — keep the last known count
  }
}
