import type { AgentTicket } from '@dashboard/shared';
import { planStaleInvalidation, type StaleInvalidationPlan } from './epic-members';

/**
 * Warning before a ticket joins a refined Epic (PD-703, D-089).
 *
 * On an Epic, `refined` means "the current members are the agreed breakdown", so a member joining
 * falsifies it and the server un-refines the Epic, automatically (D-089 §3). That stays. What this
 * adds is saying so **before** the write, and offering the obvious next step: re-refining the
 * Epic with the new member included.
 *
 * **Every choice un-refines.** §3 rejected a prompt because "left refined when it should not have
 * been" is the silent, permanent error, so there is no "keep refined" choice here, and Cancel means
 * the ticket is not added at all. The choices are only what happens next (re-refine or not) and,
 * for a running Epic, whether its armed members pause (PD-611, folded in so there is one modal).
 *
 * Plain `.ts` because `apps/web` has no component tests.
 */

export interface EpicJoinPlan {
  epic: Pick<AgentTicket, 'id' | 'displayId' | 'title'>;
  /** PD-611's pause, when the Epic is running. `pause.needsConfirm` means members would leave the Queue. */
  pause: StaleInvalidationPlan;
}

/** What the person chose in the modal. */
export interface EpicJoinChoice {
  /** Start a Refine session on the Epic after the add, and go to it. */
  reRefine: boolean;
  /** Decline the pause (only meaningful when `pause.needsConfirm`). */
  keepRunning: boolean;
}

/**
 * Whether a write moves a ticket INTO `epicId`. An edit that leaves the ticket in the Epic it is
 * already in is not a join, and neither is leaving an Epic. `existing` is null for a create.
 */
export function joinsEpic(existing: Pick<AgentTicket, 'epicId'> | null, epicId: number | null | undefined): epicId is number {
  if (epicId === null || epicId === undefined) return false;
  return existing === null || existing.epicId !== epicId;
}

/**
 * The warning to show before a ticket joins `epic`, or null when there is nothing to warn about:
 * an Epic that is not refined (never refined, or already stale) makes no claim this falsifies.
 */
export function planEpicJoin(epic: AgentTicket | null | undefined, tickets: readonly AgentTicket[]): EpicJoinPlan | null {
  if (!epic) return null;
  const pause = planStaleInvalidation(epic, tickets.filter((t) => t.epicId === epic.id));
  if (pause === null) return null;
  return { epic: { id: epic.id, displayId: epic.displayId, title: epic.title }, pause };
}

/** The write modifier for the add: `keepEpicRunning` only when there was a pause to decline. */
export function joinWriteOpts(plan: EpicJoinPlan | null, choice: EpicJoinChoice | null): { keepEpicRunning?: boolean } {
  return plan?.pause.needsConfirm && choice?.keepRunning ? { keepEpicRunning: true } : {};
}

/** The toast after an add that un-refined an Epic without re-refining it. */
export function unrefinedToast(epic: Pick<AgentTicket, 'displayId' | 'title'>): string {
  const label = epic.displayId ?? epic.title;
  return `Epic ${label} now needs re-refinement — its members changed. Re-refine it, or press ✓ Mark refined on it if the breakdown still holds.`;
}
