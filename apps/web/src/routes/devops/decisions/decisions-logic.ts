// Pure helpers for the Decisions inbox (PD-746). Kept out of the page so they are unit-testable
// (apps/web's vitest cannot import .svelte).

/** "just now", "12m ago", "3h ago", "2d ago". Clamps a future timestamp to "just now". */
export function askedAgo(askedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - askedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** What an awaiting Refine session is waiting on (PD-843): a commit `proposal` to approve or
 *  reject, a question `round` to answer, or a plain `reply` (the agent answered without asking a
 *  question or proposing). A proposal wins over a round: once the agent has proposed, the decision
 *  that moves the ticket is Approve/Reject. */
export type DecisionKind = 'proposal' | 'round' | 'reply';

export function decisionKind(item: { proposal: unknown | null; round: unknown | null }): DecisionKind {
  if (item.proposal) return 'proposal';
  if (item.round) return 'round';
  return 'reply';
}
