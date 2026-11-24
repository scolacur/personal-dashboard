// View model for the "why did this ticket close" label (PD-940; the web half of PD-888).
//
// PD-888 put `closeReason` ('split' | 'superseded' | 'duplicate' | null) and `closedInto`
// (successor display ids + titles) on the board payload. This turns those two fields into the
// copy and the links both the card and the detail banner render, so an auto-closed ticket reads
// differently from a plainly abandoned one. All of it is a pure function, reachable from a plain
// vitest spec (apps/web has no DOM test runner) — the `queue-eligibility-view.ts` pattern.

import type { AgentTicket, CloseReason, ClosedIntoRef } from '@dashboard/shared';

/** How many successor ids a card lists before collapsing the rest into "+N more". The detail
 *  banner passes no cap and lists them all. */
export const CLOSURE_CARD_CAP = 3;

/** Verb phrase for the full label — reads with the successor ids after it. */
const CLOSURE_VERB: Record<CloseReason, string> = {
  split: 'Split into',
  superseded: 'Superseded by',
  duplicate: 'Duplicate of',
};

/** Standalone noun, used when a reasoned close has no recorded successor to list. */
const CLOSURE_SHORT: Record<CloseReason, string> = {
  split: 'Split',
  superseded: 'Superseded',
  duplicate: 'Duplicate',
};

export interface ClosureSuccessor {
  displayId: string | null;
  title: string;
  /** Detail-page href, or null when there is no display id to link to. */
  href: string | null;
}

export interface ClosureLabel {
  reason: CloseReason;
  /** "Split into" / "Superseded by" / "Duplicate of". */
  verb: string;
  /** The successors shown inline (capped for a card, all of them for the detail banner). */
  shown: ClosureSuccessor[];
  /** All successors, uncapped — the detail banner lists these with their titles. */
  successors: ClosureSuccessor[];
  /** How many successors the cap hid, 0 when none were hidden. */
  overflow: number;
  /** Ready-made card text, e.g. "Split into PD-874, PD-875" (or "+2 more" appended when capped).
   *  Falls back to the standalone noun when there is no successor to name. */
  cardText: string;
}

function toSuccessor(ref: ClosedIntoRef): ClosureSuccessor {
  return {
    displayId: ref.displayId,
    title: ref.title,
    href: ref.displayId ? `/devops/tickets/${ref.displayId}` : null,
  };
}

/**
 * Map a ticket to its closure label, or null when none applies (an open ticket, or a plain/manual
 * close — `closeReason` is null — which should look exactly as it does today). `cap` limits how many
 * successors `shown` carries; pass `null` (the detail banner) for no cap.
 */
export function closureLabel(ticket: AgentTicket, cap: number | null = CLOSURE_CARD_CAP): ClosureLabel | null {
  const reason = ticket.closeReason;
  if (!reason) return null;

  const successors = (ticket.closedInto ?? []).map(toSuccessor);
  const shown = cap === null ? successors : successors.slice(0, Math.max(0, cap));
  const overflow = successors.length - shown.length;

  const verb = CLOSURE_VERB[reason];
  let cardText: string;
  if (shown.length === 0) {
    // No successor to name (closedInto absent/empty) — fall back to the bare noun.
    cardText = overflow > 0 ? `${verb} ${overflow} ticket${overflow === 1 ? '' : 's'}` : CLOSURE_SHORT[reason];
  } else {
    const ids = shown.map((s) => s.displayId ?? '?').join(', ');
    cardText = overflow > 0 ? `${verb} ${ids}, +${overflow} more` : `${verb} ${ids}`;
  }

  return { reason, verb, shown, successors, overflow, cardText };
}
