import type { AwaitingEscalationItem, EscalationReason } from '@dashboard/shared';

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

/** The inbox's kinds of decision, one per section (PD-1007). `escalation` is its own kind so the
 *  collapsible sections (PD-797) and colour-coded types (PD-800) can pick the section up. */
export type InboxDecisionKind = 'visual' | 'escalation' | 'refine';
export const ESCALATION_DECISION_KIND: InboxDecisionKind = 'escalation';

/** The reason chip's words (PD-1007): why the Evaluator handed the PR back. */
export function escalationReasonLabel(reason: EscalationReason): string {
  switch (reason) {
    case 'escalate':
      return 'Escalated';
    case 'round-cap':
      return 'Round cap';
    case 'no-verdict':
      return 'No verdict';
  }
}

/** One line under the chip saying what the reason means for this PR. */
export function escalationReasonDetail(item: Pick<AwaitingEscalationItem, 'reason' | 'round' | 'lenses'>): string {
  if (item.reason === 'escalate') {
    const by = item.lenses.filter((l) => l.verdict === 'escalate').map((l) => l.lens);
    return `The ${by.join(' and ') || 'code'} review escalated it in round ${item.round}.`;
  }
  if (item.reason === 'round-cap') return `Changes were still requested at the round cap (round ${item.round}).`;
  const missing = item.lenses.filter((l) => l.verdict === null).map((l) => l.lens);
  return `The ${missing.join(' and ') || 'code'} review produced no verdict after its one retry.`;
}

/** The card's heading: the ticket when the PR has one, else the PR itself. */
export function escalationHeading(item: Pick<AwaitingEscalationItem, 'ticket' | 'prNumber'>): { id: string; title: string } {
  if (item.ticket) return { id: item.ticket.displayId ?? `#${item.ticket.id}`, title: item.ticket.title };
  return { id: `PR #${item.prNumber}`, title: 'No linked ticket' };
}

/** Lenses with something to show: a summary or blocking findings. A no-verdict lens has neither. */
export function escalationLensesToShow<T extends { summary: string; blockingFindings: unknown[] }>(lenses: readonly T[]): T[] {
  return lenses.filter((l) => l.summary.trim() !== '' || l.blockingFindings.length > 0);
}
