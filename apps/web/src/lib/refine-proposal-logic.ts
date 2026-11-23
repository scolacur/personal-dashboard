// Pure helpers for the Refine commit-proposal card (D-044, PD-269), shared by the ticket thread and
// the Decisions inbox (PD-843). Kept out of the component so they are unit-testable (apps/web's
// vitest cannot import .svelte).
import { isReady, type RefineChildProposal, type RefineProposal } from '@dashboard/shared';

/** The badge text for a proposal's mode. A decompose of an Epic is a Populate (PD-634). */
export function proposalModeLabel(proposal: RefineProposal, isEpic: boolean): string {
  if (proposal.mode === 'decompose') return isEpic ? 'Populate' : 'Split';
  return 'Refine in place';
}

/** "Approve & queue" (D-057) is offered only for a non-Epic refine_in_place: decompose routes
 *  per-child and an Epic can never enter the Queue. */
export function proposalCanQueue(proposal: RefineProposal, isEpic: boolean): boolean {
  return proposal.mode === 'refine_in_place' && !isEpic;
}

/** A soft hint: the ticket can still be queued, but its proposed body lacks the four Ready sections. */
export function proposalNotReady(proposal: RefineProposal): boolean {
  return proposal.mode === 'refine_in_place' && !isReady(proposal.body ?? null);
}

/** PD-634: mirrors the server's `approveRefine`. A child lands refined unless the agent said
 *  otherwise, or it is robot-assigned and fails the Ready check. */
export function childBornRefined(child: RefineChildProposal): boolean {
  return (child.refined ?? true) && (child.assignee !== 'robot' || isReady(child.body));
}

/** The summary line of a collapsed proposal (PD-843): what opening it will show. */
export function proposalDetailsSummary(proposal: RefineProposal, isEpic: boolean): string {
  if (proposal.mode === 'refine_in_place') return 'Proposed body';
  const n = proposal.children?.length ?? 0;
  const noun = isEpic ? (n === 1 ? 'member' : 'members') : n === 1 ? 'ticket' : 'tickets';
  const children = `${n} proposed ${noun}`;
  return isEpic && proposal.body ? `Epic description and ${children}` : children;
}

/** What to tell Steve after an approval, from what the server says it did. */
export function approvedMessage(result: { queued: boolean; populated: boolean }): string {
  if (result.populated) return 'Approved — members created under this Epic. Queue the ready ones when you are.';
  if (result.queued) return 'Approved & queued — Robot will pick it up.';
  return "Approved. Drag to the Robot's Queue when you're ready to dispatch.";
}

export const REJECTED_MESSAGE = 'Proposal rejected — the agent can propose again.';

/** PD-929: the copy for a terminal-ticket refusal — the ticket reached `completed`/`closed` after
 *  its proposal was stored (D-036), so `approveRefine` refuses it server-side (`409 TERMINAL`). */
export const TERMINAL_MESSAGE =
  'This ticket is closed/completed — its proposal can no longer be approved.';

/** Map a failed approval to the message to show, keyed on the server's error `code`. Returns our
 *  own copy for the codes we phrase ourselves (PD-929: `TERMINAL`), else `null` so the caller falls
 *  back to the raw server error. Pure so the copy is unit-testable (apps/web vitest can't import
 *  `.svelte`). */
export function approveFailureMessage(code: string | null | undefined): string | null {
  return code === 'TERMINAL' ? TERMINAL_MESSAGE : null;
}
