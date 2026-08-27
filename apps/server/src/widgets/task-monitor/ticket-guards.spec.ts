import { describe, it, expect } from 'vitest';
import type { TicketStatus } from '@dashboard/shared';
import { createGuardFailure, patchGuardFailure, reopenGuardFailure } from './ticket-guards';

function existing(over: Partial<{ status: TicketStatus; isEpic: boolean; epicId: number | null }> = {}) {
  return { status: 'backlog' as TicketStatus, isEpic: false, epicId: 7, ...over };
}

describe('patchGuardFailure — terminal is final (D-TMP-PD539a)', () => {
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

describe('patchGuardFailure — a Ticket never leaves its Epic (D-TMP-PD383a)', () => {
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
