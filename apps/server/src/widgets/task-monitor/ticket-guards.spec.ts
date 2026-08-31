import { describe, it, expect } from 'vitest';
import type { AgentState, TicketStatus } from '@dashboard/shared';
import { createGuardFailure, patchGuardFailure, reopenGuardFailure } from './ticket-guards';

function existing(
  over: Partial<{
    status: TicketStatus;
    isEpic: boolean;
    epicId: number | null;
    agentState: AgentState | null;
  }> = {},
) {
  return { status: 'backlog' as TicketStatus, isEpic: false, epicId: 7, agentState: null as AgentState | null, ...over };
}

describe('patchGuardFailure — terminal is final (D-083)', () => {
  it('refuses a plain status write out of terminal, and names the way out', () => {
    for (const status of ['completed', 'closed'] as const) {
      const fail = patchGuardFailure(existing({ status }), { status: 'backlog' });
      expect(fail?.code).toBe('TERMINAL_IS_FINAL');
      expect(fail?.message).toMatch(/reopen/i);
    }
  });

  it('refuses content edits on a terminal Ticket, listing what it refused', () => {
    const fail = patchGuardFailure(existing({ status: 'completed' }), {
      title: 'rewritten',
      body: 'x',
    });
    expect(fail?.code).toBe('TERMINAL_IS_READ_ONLY');
    expect(fail?.message).toContain('title');
    expect(fail?.message).toContain('body');
  });

  // The record is allowed to gain bookkeeping after the fact — that changes nothing about what it
  // says was done, which is the thing the rule protects.
  it('still allows the issue link and archiving', () => {
    expect(patchGuardFailure(existing({ status: 'completed' }), { githubIssueNumber: 42 })).toBeNull();
    expect(patchGuardFailure(existing({ status: 'closed' }), { archivedAt: 'now' })).toBeNull();
  });

  // PD-590: refusing this broke reordering any Epic member list containing a completed ticket.
  // Position is not part of the record — a completed member still sits somewhere among its
  // siblings, and moving it there rewrites nothing about what was done.
  it('allows reordering a terminal Ticket within its Epic', () => {
    expect(patchGuardFailure(existing({ status: 'completed' }), { sortOrder: 42 })).toBeNull();
    expect(patchGuardFailure(existing({ status: 'closed' }), { sortOrder: 1.5 })).toBeNull();
  });

  it('still refuses content edits sent alongside a reorder', () => {
    const fail = patchGuardFailure(existing({ status: 'completed' }), { sortOrder: 42, title: 'x' });
    expect(fail?.code).toBe('TERMINAL_IS_READ_ONLY');
    expect(fail?.message).toContain('title');
    expect(fail?.message).not.toContain('sortOrder');
  });

  it('lets a terminal Ticket move between terminal lanes', () => {
    expect(patchGuardFailure(existing({ status: 'completed' }), { status: 'closed' })).toBeNull();
  });

  // An Epic's lane is DERIVED from its members, so there is nothing there to freeze; freezing it
  // would freeze a value nothing ever wrote.
  it('exempts Epics entirely', () => {
    const epic = existing({ status: 'completed', isEpic: true, epicId: null });
    expect(patchGuardFailure(epic, { status: 'backlog' })).toBeNull();
    expect(patchGuardFailure(epic, { title: 'renamed' })).toBeNull();
  });

  it('does not touch an active Ticket', () => {
    expect(patchGuardFailure(existing({ status: 'queue' }), { title: 'fine' })).toBeNull();
  });
});

describe('patchGuardFailure — a Ticket never leaves its Epic (D-080)', () => {
  it('refuses un-parenting an active Ticket', () => {
    const fail = patchGuardFailure(existing({ status: 'backlog', epicId: 7 }), { epicId: null });
    expect(fail?.code).toBe('EPIC_REQUIRED');
    expect(fail?.message).toMatch(/another one/i);
  });

  it('allows moving between Epics', () => {
    expect(patchGuardFailure(existing({ epicId: 7 }), { epicId: 9 })).toBeNull();
  });

  // Requiring an Epic on every *edit* would enforce the model retroactively against history. The
  // create-time rule is global; this one is not, deliberately — legacy terminal tickets predate it.
  it('leaves a Ticket that never had an Epic alone', () => {
    expect(patchGuardFailure(existing({ epicId: null }), { title: 'edit' })).toBeNull();
    expect(patchGuardFailure(existing({ epicId: null }), { epicId: null })).toBeNull();
  });

  // Terminal read-only wins, and that ordering is the right way round: a completed member's Epic
  // membership is part of what the Epic's roll-up counted, so un-parenting it edits history rather
  // than tidying it. Re-filing a finished Ticket means reopening it first — deliberately.
  it('refuses un-parenting a terminal Ticket too, as a read-only edit', () => {
    const fail = patchGuardFailure(existing({ status: 'completed', epicId: 7 }), { epicId: null });
    expect(fail?.code).toBe('TERMINAL_IS_READ_ONLY');
  });

  it('allows promoting a Ticket to an Epic, which clears the parent by definition', () => {
    expect(patchGuardFailure(existing({ epicId: 7 }), { isEpic: true, epicId: null })).toBeNull();
  });
});

// PD-590. The loop tracks a dispatched run by `status = 'queue'` + `agent_state`; moving the
// ticket out mid-flight orphans the run, which keeps going regardless (D-046) and completes
// nothing. PD-536 already refuses this for Epic rollback; this is the single-ticket gesture.
describe('patchGuardFailure — a live run is never silently detached', () => {
  it('refuses moving a working or in-review ticket out of the queue', () => {
    for (const state of ['working', 'in-review'] as const) {
      const fail = patchGuardFailure(
        existing({ status: 'queue', agentState: state }),
        { status: 'backlog' },
      );
      expect(fail?.code).toBe('RUN_IN_FLIGHT');
    }
  });

  it('explains what to do, differently for each state', () => {
    const working = patchGuardFailure(existing({ status: 'queue', agentState: 'working' }), { status: 'backlog' })!;
    expect(working.message).toMatch(/hand off|cannot be interrupted/i);
    const review = patchGuardFailure(existing({ status: 'queue', agentState: 'in-review' }), { status: 'backlog' })!;
    expect(review.message).toMatch(/pr/i);
  });

  it('allows moving a ticket that is merely waiting, or not running at all', () => {
    expect(patchGuardFailure(existing({ status: 'queue', agentState: 'queued' }), { status: 'backlog' })).toBeNull();
    expect(patchGuardFailure(existing({ status: 'queue', agentState: null }), { status: 'backlog' })).toBeNull();
  });

  // Parked states are exactly the ones a human needs to be able to pull back.
  it('allows pulling back a parked ticket', () => {
    for (const state of ['stuck', 'needs-human', 'awaiting-human'] as const) {
      expect(patchGuardFailure(existing({ status: 'queue', agentState: state }), { status: 'backlog' })).toBeNull();
    }
  });

  it('does not block edits that leave the ticket in the queue', () => {
    expect(patchGuardFailure(existing({ status: 'queue', agentState: 'working' }), { title: 'retitle' })).toBeNull();
  });
});

describe('createGuardFailure', () => {
  it('refuses a new Ticket with no Epic', () => {
    expect(createGuardFailure({ status: 'backlog' })?.code).toBe('EPIC_REQUIRED');
    expect(createGuardFailure({ epicId: null })?.code).toBe('EPIC_REQUIRED');
  });

  it('accepts one that names its Epic', () => {
    expect(createGuardFailure({ epicId: 7 })).toBeNull();
  });

  it('never requires an Epic of an Epic — they do not nest', () => {
    expect(createGuardFailure({ isEpic: true })).toBeNull();
  });

  // Global — no per-project escape. C-89 adopted every active Core ticket into an Epic first, so
  // there is no project left that cannot satisfy it.
  it('applies to every project, with no opt-out', () => {
    expect(createGuardFailure({ status: 'backlog', epicId: null })?.code).toBe('EPIC_REQUIRED');
  });

  // Recording something already finished is bookkeeping about the past, not new work to price.
  it('exempts a create straight into a terminal lane', () => {
    expect(createGuardFailure({ status: 'completed' })).toBeNull();
    expect(createGuardFailure({ status: 'closed' })).toBeNull();
  });
});

describe('reopenGuardFailure', () => {
  it('needs the Ticket to actually be terminal', () => {
    expect(reopenGuardFailure(existing({ status: 'queue' }), undefined)?.code).toBe('NOT_TERMINAL');
  });

  it('refuses to reopen into an Epic-less dead end, and says what is missing', () => {
    const fail = reopenGuardFailure(existing({ status: 'completed', epicId: null }), undefined);
    expect(fail?.code).toBe('EPIC_REQUIRED');
    expect(fail?.message).toMatch(/epicId/);
  });

  it('accepts a supplied Epic, or the one it already had', () => {
    expect(reopenGuardFailure(existing({ status: 'completed', epicId: null }), 9)).toBeNull();
    expect(reopenGuardFailure(existing({ status: 'closed', epicId: 7 }), undefined)).toBeNull();
  });

  it('refuses an Epic — its lane is derived, so there is nothing to reopen', () => {
    const fail = reopenGuardFailure(existing({ status: 'completed', isEpic: true }), undefined);
    expect(fail?.code).toBe('EPIC_NOT_REOPENABLE');
  });
});
