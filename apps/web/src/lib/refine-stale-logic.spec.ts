import { describe, it, expect } from 'vitest';
import {
  REFINE_EVENT_TYPE,
  REFINE_PROPOSAL_EVENT,
  REFINE_ROUND_STALE_EVENT,
  type RefineProposal,
  type RefineRoundStaleDetail,
  type TicketEvent,
} from '@dashboard/shared';
import {
  ROUND_STALE_MESSAGE,
  answerFailureMessage,
  latestRefineStale,
  staleInvalidatesProposal,
  staleInvalidatesRound,
  staleProposal,
  staleReasonText,
} from './refine-stale-logic';

let nextId = 1;
function ev(type: string, detail: unknown, createdAt = nextId): TicketEvent {
  return { id: nextId++, ticketId: 7, type, detail, createdAt };
}

const staleDetail = (over: Partial<RefineRoundStaleDetail> = {}): RefineRoundStaleDetail => ({
  text: 'agent-facing message',
  changedTicketId: 455,
  changedDisplayId: 'PD-455',
  change: 'split',
  invalidates: 'round',
  ...over,
});

const round = { questions: [], assumptions: [] };
const proposal: RefineProposal = { mode: 'refine_in_place', body: 'x' };

describe('refine stale logic (PD-889)', () => {
  it('detects stale only when the newest Refine-state event is a stale turn', () => {
    const d = staleDetail();
    expect(
      latestRefineStale([
        ev(REFINE_EVENT_TYPE.human, { text: 'hi' }),
        ev(REFINE_EVENT_TYPE.agent, { text: 'q', round }),
        ev(REFINE_ROUND_STALE_EVENT, d),
      ]),
    ).toEqual(d);
  });

  it('is not stale when a later agent turn re-grounded the session', () => {
    expect(
      latestRefineStale([
        ev(REFINE_EVENT_TYPE.agent, { text: 'q', round }),
        ev(REFINE_ROUND_STALE_EVENT, staleDetail()),
        ev(REFINE_EVENT_TYPE.agent, { text: 'new q', round }),
      ]),
    ).toBeNull();
  });

  it('is not stale with no stale event, and orders by createdAt then id', () => {
    expect(latestRefineStale([ev(REFINE_EVENT_TYPE.agent, { text: 'q', round })])).toBeNull();
    // same createdAt: higher id wins
    const d = staleDetail();
    const a = ev(REFINE_ROUND_STALE_EVENT, d, 100);
    const b = ev(REFINE_EVENT_TYPE.agent, { text: 'q' }, 100);
    expect(latestRefineStale([a, b])).toBeNull(); // b (agent) has the higher id → newest
  });

  it('ignores non-Refine-state events when finding the newest', () => {
    const d = staleDetail();
    expect(
      latestRefineStale([ev(REFINE_ROUND_STALE_EVENT, d), ev('status_changed', { to: 'queue' })]),
    ).toEqual(d);
  });

  it('rejects a malformed stale detail', () => {
    expect(latestRefineStale([ev(REFINE_ROUND_STALE_EVENT, null)])).toBeNull();
    expect(latestRefineStale([ev(REFINE_ROUND_STALE_EVENT, { change: 'nope', invalidates: 'round' })])).toBeNull();
    expect(latestRefineStale([ev(REFINE_ROUND_STALE_EVENT, { change: 'split', invalidates: 'wat' })])).toBeNull();
  });

  it('classifies which artefact a stale turn invalidated', () => {
    expect(staleInvalidatesRound(staleDetail({ invalidates: 'round' }))).toBe(true);
    expect(staleInvalidatesRound(staleDetail({ invalidates: 'both' }))).toBe(true);
    expect(staleInvalidatesRound(staleDetail({ invalidates: 'proposal' }))).toBe(false);
    expect(staleInvalidatesProposal(staleDetail({ invalidates: 'proposal' }))).toBe(true);
    expect(staleInvalidatesProposal(staleDetail({ invalidates: 'both' }))).toBe(true);
    expect(staleInvalidatesProposal(staleDetail({ invalidates: 'round' }))).toBe(false);
  });

  it('returns the stale proposal to render greyed, but only when a proposal went stale', () => {
    const events = [
      ev(REFINE_PROPOSAL_EVENT.proposal, proposal),
      ev(REFINE_ROUND_STALE_EVENT, staleDetail({ invalidates: 'proposal' })),
    ];
    expect(staleProposal(events)).toEqual(proposal);
    // round-only stale: no proposal to show
    const roundOnly = [
      ev(REFINE_PROPOSAL_EVENT.proposal, proposal),
      ev(REFINE_ROUND_STALE_EVENT, staleDetail({ invalidates: 'round' })),
    ];
    expect(staleProposal(roundOnly)).toBeNull();
    // not stale at all
    expect(staleProposal([ev(REFINE_PROPOSAL_EVENT.proposal, proposal)])).toBeNull();
  });

  it('builds a one-line reason from the detail, with phrasing per trigger and subject', () => {
    expect(staleReasonText(staleDetail({ change: 'split', invalidates: 'round' }))).toBe(
      'PD-455 was split into other tickets since this was asked — updating…',
    );
    expect(staleReasonText(staleDetail({ change: 'completed', invalidates: 'proposal' }))).toBe(
      'PD-455 was completed since this was proposed — updating…',
    );
    expect(staleReasonText(staleDetail({ change: 'body', invalidates: 'both' }))).toBe(
      'PD-455 had its description rewritten since these were raised — updating…',
    );
  });

  it('falls back to the ticket id when the changed ticket has no display id', () => {
    expect(staleReasonText(staleDetail({ changedDisplayId: null, changedTicketId: 88 }))).toBe(
      'ticket 88 was split into other tickets since this was asked — updating…',
    );
  });

  it('maps a ROUND_STALE answer refusal to its own copy, else null', () => {
    expect(answerFailureMessage('ROUND_STALE')).toBe(ROUND_STALE_MESSAGE);
    expect(ROUND_STALE_MESSAGE).toMatch(/went stale/);
    expect(answerFailureMessage('BAD_ANSWER')).toBeNull();
    expect(answerFailureMessage(null)).toBeNull();
    expect(answerFailureMessage(undefined)).toBeNull();
  });
});
