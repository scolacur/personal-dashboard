import { describe, it, expect } from 'vitest';
import type { AgentTicket, ClosedIntoRef } from '@dashboard/shared';
import { closureLabel, CLOSURE_CARD_CAP } from './closure-label';

function ticket(overrides: Partial<AgentTicket>): AgentTicket {
  return {
    id: 1,
    displayId: 'PD-1',
    title: 'A ticket',
    body: null,
    status: 'closed',
    priority: null,
    sortOrder: 0,
    projectId: 1,
    assignee: null,
    source: 'manual',
    githubIssueNumber: null,
    githubIssueUrl: null,
    recurInterval: null,
    agentState: null,
    agentTurns: null,
    refineState: null,
    refineStale: false,
    refined: false,
    ready: false,
    readyBypassed: false,
    maxTurns: null,
    kind: null,
    coderArea: null,
    isEpic: false,
    epicId: null,
    closeReason: null,
    closedInto: [],
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as AgentTicket;
}

function ref(displayId: string | null, title: string): ClosedIntoRef {
  return { displayId, title };
}

describe('closureLabel', () => {
  it('returns null for a plain/manual close (no closeReason) — looks as it does today', () => {
    expect(closureLabel(ticket({ closeReason: null }))).toBeNull();
  });

  it('returns null for an open ticket (no closeReason)', () => {
    expect(closureLabel(ticket({ status: 'queue', closeReason: null }))).toBeNull();
  });

  it('labels a split with "Split into" and links each successor', () => {
    const label = closureLabel(
      ticket({ closeReason: 'split', closedInto: [ref('PD-874', 'Child A'), ref('PD-875', 'Child B')] }),
    );
    expect(label).not.toBeNull();
    expect(label!.reason).toBe('split');
    expect(label!.verb).toBe('Split into');
    expect(label!.cardText).toBe('Split into PD-874, PD-875');
    expect(label!.successors.map((s) => s.href)).toEqual([
      '/devops/tickets/PD-874',
      '/devops/tickets/PD-875',
    ]);
    expect(label!.overflow).toBe(0);
  });

  it('labels a superseded ticket with "Superseded by"', () => {
    const label = closureLabel(ticket({ closeReason: 'superseded', closedInto: [ref('PD-900', 'The new one')] }));
    expect(label!.verb).toBe('Superseded by');
    expect(label!.cardText).toBe('Superseded by PD-900');
  });

  it('labels a duplicate with "Duplicate of"', () => {
    const label = closureLabel(ticket({ closeReason: 'duplicate', closedInto: [ref('PD-42', 'The original')] }));
    expect(label!.verb).toBe('Duplicate of');
    expect(label!.cardText).toBe('Duplicate of PD-42');
  });

  it('caps the ids listed on a card and appends "+N more"', () => {
    const closedInto = ['PD-1', 'PD-2', 'PD-3', 'PD-4', 'PD-5'].map((id) => ref(id, id));
    const label = closureLabel(ticket({ closeReason: 'split', closedInto }), 3);
    expect(label!.shown).toHaveLength(3);
    expect(label!.overflow).toBe(2);
    expect(label!.cardText).toBe('Split into PD-1, PD-2, PD-3, +2 more');
    // The uncapped list is always complete, for the detail banner.
    expect(label!.successors).toHaveLength(5);
  });

  it('does not cap when cap is null (the detail banner lists all)', () => {
    const closedInto = ['PD-1', 'PD-2', 'PD-3', 'PD-4'].map((id) => ref(id, id));
    const label = closureLabel(ticket({ closeReason: 'split', closedInto }), null);
    expect(label!.shown).toHaveLength(4);
    expect(label!.overflow).toBe(0);
  });

  it('defaults the cap to CLOSURE_CARD_CAP', () => {
    const closedInto = Array.from({ length: CLOSURE_CARD_CAP + 2 }, (_, i) => ref(`PD-${i}`, `t${i}`));
    const label = closureLabel(ticket({ closeReason: 'split', closedInto }));
    expect(label!.shown).toHaveLength(CLOSURE_CARD_CAP);
    expect(label!.overflow).toBe(2);
  });

  it('falls back to a bare noun when a reasoned close has no recorded successor', () => {
    expect(closureLabel(ticket({ closeReason: 'split', closedInto: [] }))!.cardText).toBe('Split');
    expect(closureLabel(ticket({ closeReason: 'superseded', closedInto: undefined }))!.cardText).toBe('Superseded');
    expect(closureLabel(ticket({ closeReason: 'duplicate', closedInto: [] }))!.cardText).toBe('Duplicate');
  });

  it('leaves a successor without a display id unlinked', () => {
    const label = closureLabel(ticket({ closeReason: 'duplicate', closedInto: [ref(null, 'Legacy row')] }));
    expect(label!.successors[0].href).toBeNull();
    expect(label!.cardText).toBe('Duplicate of ?');
  });
});
