import { writable } from 'svelte/store';
import { fetchAwaitingRefine, fetchAwaitingVisual, fetchTicketSuggestions } from '../routes/devops/api';

// How many Refine sessions are waiting on Steve — the Decisions nav badge (PD-746). One store so
// the badge and the Decisions page agree, and an answer sent from the page updates the badge
// without waiting for the next poll.
export const decisionsCount = writable(0);

/** Re-fetch the count and publish it. Best-effort: a failed poll keeps the last known count. */
export async function refreshDecisionsCount(): Promise<void> {
  try {
    // PD-773: visual checks wait on Steve too, so they count toward the same badge. PD-979 (D-119):
    // pending ticket suggestions do as well.
    const [refine, visual, suggestions] = await Promise.all([
      fetchAwaitingRefine(),
      fetchAwaitingVisual().catch(() => ({ count: 0 })),
      fetchTicketSuggestions().catch(() => ({ count: 0 })),
    ]);
    decisionsCount.set(refine.count + visual.count + suggestions.count);
  } catch {
    // transient — keep the last known count
  }
}
