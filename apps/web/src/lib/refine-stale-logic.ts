// Pure helpers for the stale-round / stale-proposal UI (PD-889 web half). Kept out of the
// components so they are unit-testable: apps/web's vitest runs without the SvelteKit plugin, so
// nothing reachable from a spec may import a `.svelte` file.
//
// PD-889 (server/worker half) appends a `refine_round_stale` event to a session when a ticket an
// open round or pending proposal cited changes. That event is newest-wins among the Refine-state
// events, so while it is the newest one the round/proposal it invalidated is stale: a late answer
// is refused `ROUND_STALE`, the proposal stops being actionable, and the worker re-grounds. This
// module turns that fact into the two things the UI needs — the detection rule and the reason copy.
import {
  REFINE_PROPOSAL_EVENT,
  REFINE_ROUND_STALE_EVENT,
  REFINE_STATE_EVENT_TYPES,
  type RefineProposal,
  type RefineRoundStaleDetail,
  type TicketEvent,
} from '@dashboard/shared';

const STALE_CHANGES: readonly RefineRoundStaleDetail['change'][] = [
  'completed',
  'closed',
  'split',
  'superseded',
  'duplicate',
  'body',
  'epic_move',
];

const STALE_INVALIDATES: readonly RefineRoundStaleDetail['invalidates'][] = ['round', 'proposal', 'both'];

/** Narrow a parsed event `detail` to a `RefineRoundStaleDetail`, or null when malformed. Defensive
 *  because `TicketEvent.detail` is `unknown` (parsed JSON of any stored shape). */
function asStaleDetail(detail: unknown): RefineRoundStaleDetail | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  if (!STALE_CHANGES.includes(d.change as RefineRoundStaleDetail['change'])) return null;
  if (!STALE_INVALIDATES.includes(d.invalidates as RefineRoundStaleDetail['invalidates'])) return null;
  return {
    text: typeof d.text === 'string' ? d.text : '',
    changedTicketId: typeof d.changedTicketId === 'number' ? d.changedTicketId : 0,
    changedDisplayId: typeof d.changedDisplayId === 'string' ? d.changedDisplayId : null,
    change: d.change as RefineRoundStaleDetail['change'],
    invalidates: d.invalidates as RefineRoundStaleDetail['invalidates'],
  };
}

/** The newest Refine-state event (by createdAt, then id), or null. Mirrors the server's
 *  newest-wins ordering (`newestRefineStateIsStale`). */
function newestStateEvent(events: readonly TicketEvent[]): TicketEvent | null {
  let newest: TicketEvent | null = null;
  for (const e of events) {
    if (!REFINE_STATE_EVENT_TYPES.includes(e.type)) continue;
    if (newest === null || e.createdAt > newest.createdAt || (e.createdAt === newest.createdAt && e.id > newest.id)) {
      newest = e;
    }
  }
  return newest;
}

/**
 * The stale-detection rule (PD-889): a session's open round / pending proposal is stale exactly
 * when the newest Refine-state event is a `refine_round_stale` turn. Returns its detail, or null.
 * While this holds the worker is re-grounding the session, so the artefact it invalidated must
 * render read-only. A later agent turn (the re-grounded round/proposal) becomes newest and clears it.
 */
export function latestRefineStale(events: readonly TicketEvent[]): RefineRoundStaleDetail | null {
  const newest = newestStateEvent(events);
  if (!newest || newest.type !== REFINE_ROUND_STALE_EVENT) return null;
  return asStaleDetail(newest.detail);
}

/** The pending proposal that a stale turn invalidated (so it can be shown greyed out), or null.
 *  Only the newest `refine_proposal` event — `latestActionableProposal` returns null once the stale
 *  turn is newest, so this is how the thread still shows what went stale. Null when the stale turn
 *  invalidated only a round. */
export function staleProposal(events: readonly TicketEvent[]): RefineProposal | null {
  const stale = latestRefineStale(events);
  if (!stale || stale.invalidates === 'round') return null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === REFINE_PROPOSAL_EVENT.proposal) return (events[i].detail ?? {}) as RefineProposal;
  }
  return null;
}

/** Whether a stale turn invalidated the open round (so the answer form must be withheld). */
export function staleInvalidatesRound(detail: RefineRoundStaleDetail): boolean {
  return detail.invalidates !== 'proposal';
}

/** Whether a stale turn invalidated the pending proposal. */
export function staleInvalidatesProposal(detail: RefineRoundStaleDetail): boolean {
  return detail.invalidates !== 'round';
}

// How each trigger reads in the one-line reason. Past tense, since the change has already happened.
const CHANGE_PHRASE: Record<RefineRoundStaleDetail['change'], string> = {
  completed: 'was completed',
  closed: 'was closed',
  split: 'was split into other tickets',
  superseded: 'was superseded',
  duplicate: 'was closed as a duplicate',
  body: 'had its description rewritten',
  epic_move: 'was moved to a different Epic',
};

// What the stale artefact is, so the clause reads naturally for a round, a proposal, or both.
const STALE_SUBJECT: Record<RefineRoundStaleDetail['invalidates'], string> = {
  round: 'since this was asked',
  proposal: 'since this was proposed',
  both: 'since these were raised',
};

/**
 * The one-line reason shown above a greyed-out stale round/proposal, built from the stale event's
 * detail (PD-889), e.g. "PD-455 was split into other tickets since this was asked — updating…".
 * The "— updating…" tail reflects that the worker is re-grounding the session right now.
 */
export function staleReasonText(detail: RefineRoundStaleDetail): string {
  const ref = detail.changedDisplayId ?? `ticket ${detail.changedTicketId}`;
  return `${ref} ${CHANGE_PHRASE[detail.change]} ${STALE_SUBJECT[detail.invalidates]} — updating…`;
}

/** Copy for the Decisions inbox when `postRefineAnswers` is refused `409 ROUND_STALE` (PD-889): the
 *  round went stale between load and submit. Shown instead of the raw server error, and the list is
 *  refreshed so the now-stale item drops out. */
export const ROUND_STALE_MESSAGE =
  'This round just went stale — a ticket it relied on changed, and the Refine agent is re-grounding it. Refreshing…';

/** Map a failed answer submission to our own copy, keyed on the server error `code`: `ROUND_STALE`
 *  gets the stale copy, anything else returns null so the caller falls back to the raw message.
 *  Pure, mirroring `approveFailureMessage`, so the copy is unit-testable. */
export function answerFailureMessage(code: string | null | undefined): string | null {
  return code === 'ROUND_STALE' ? ROUND_STALE_MESSAGE : null;
}
