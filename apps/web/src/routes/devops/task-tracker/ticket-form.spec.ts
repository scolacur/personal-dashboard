import { describe, it, expect } from 'vitest';
import type { AgentTicket } from '@dashboard/shared';
import { ROBOT_MAX_TURNS_LIMIT } from '@dashboard/shared';
import {
  emptyTicketForm,
  epicRequired,
  maxTurnsInvalid,
  saveChecks,
  ticketFormError,
  ticketToForm,
  type TicketFormState,
} from './ticket-form';

function form(overrides: Partial<TicketFormState> = {}): TicketFormState {
  return { ...emptyTicketForm('backlog', 1), title: 'A ticket', ...overrides };
}

const creating = { requireEpic: true };
const editing = { requireEpic: false };

describe('maxTurnsInvalid', () => {
  it('treats blank as valid — blank means "use the default"', () => {
    expect(maxTurnsInvalid('')).toBe(false);
    expect(maxTurnsInvalid('   ')).toBe(false);
  });

  it('rejects non-integers, zero, negatives and anything over the limit', () => {
    expect(maxTurnsInvalid('0')).toBe(true);
    expect(maxTurnsInvalid('-3')).toBe(true);
    expect(maxTurnsInvalid('2.5')).toBe(true);
    expect(maxTurnsInvalid('abc')).toBe(true);
    expect(maxTurnsInvalid(String(ROBOT_MAX_TURNS_LIMIT + 1))).toBe(true);
  });

  it('accepts the bounds themselves', () => {
    expect(maxTurnsInvalid('1')).toBe(false);
    expect(maxTurnsInvalid(String(ROBOT_MAX_TURNS_LIMIT))).toBe(false);
  });
});

describe('ticketFormError', () => {
  it('needs a title and a project first', () => {
    expect(ticketFormError(form({ title: '  ' }), creating)).toMatch(/title/i);
    expect(ticketFormError(form({ projectId: null }), creating)).toMatch(/project/i);
  });

  // D-080 slice C: every Ticket belongs to an Epic.
  it('refuses to CREATE a Ticket with no Epic', () => {
    expect(ticketFormError(form({ epicId: null }), creating)).toMatch(/belongs to an Epic/i);
    expect(ticketFormError(form({ epicId: 7 }), creating)).toBeNull();
  });

  it('does NOT block editing when the caller says an Epic is not required', () => {
    expect(ticketFormError(form({ epicId: null }), editing)).toBeNull();
  });

  it('never requires an Epic of an Epic — they do not nest', () => {
    expect(ticketFormError(form({ isEpic: true, epicId: null }), creating)).toBeNull();
  });

  it('accepts a new-Epic draft in place of a picked Epic, but it must be named', () => {
    expect(
      ticketFormError(form({ epicId: null, newEpic: { title: 'Search v2', priority: 'P2' } }), creating),
    ).toBeNull();
    expect(
      ticketFormError(form({ epicId: null, newEpic: { title: '   ', priority: 'P2' } }), creating),
    ).toMatch(/name the new epic/i);
  });

  // A draft with no priority is allowed: the server treats an unpriced Epic as "leave members
  // alone", so this is honest rather than a silent P-something.
  it('allows a new Epic with no priority chosen', () => {
    expect(
      ticketFormError(form({ epicId: null, newEpic: { title: 'Later', priority: null } }), creating),
    ).toBeNull();
  });

  it('reports a bad turn ceiling last, once the rest is valid', () => {
    expect(ticketFormError(form({ epicId: 7, maxTurns: '999999' }), creating)).toMatch(/turn ceiling/i);
    expect(ticketFormError(form({ epicId: 7, maxTurns: '25' }), creating)).toBeNull();
  });
});


describe('epicRequired', () => {
  it('always requires one on create', () => {
    expect(epicRequired({ creating: true, hadEpic: false, status: 'backlog' })).toBe(true);
    expect(epicRequired({ creating: true, hadEpic: false, status: 'completed' })).toBe(true);
  });

  // The rule the board actually needs: a Ticket may move BETWEEN Epics, never out of one. An
  // orphaned active Ticket is unpriced and undispatchable by construction.
  it('refuses to let a Ticket that has an Epic be moved out of one', () => {
    for (const status of ['backlog', 'queue', 'completed', 'closed'] as const) {
      expect(epicRequired({ creating: false, hadEpic: true, status })).toBe(true);
    }
  });

  it('makes an active Epic-less Ticket adopt one on the next edit', () => {
    expect(epicRequired({ creating: false, hadEpic: false, status: 'backlog' })).toBe(true);
    expect(epicRequired({ creating: false, hadEpic: false, status: 'queue' })).toBe(true);
  });

  // Legacy only: ~141 terminal tickets predate the rule. Requiring one there would enforce the
  // model against history, and backfilling would add ~125 single-member Epics to the Completed band.
  it('leaves a terminal Epic-less Ticket editable', () => {
    expect(epicRequired({ creating: false, hadEpic: false, status: 'completed' })).toBe(false);
    expect(epicRequired({ creating: false, hadEpic: false, status: 'closed' })).toBe(false);
  });
});

describe('saveChecks', () => {
  const existing = {
    id: 7,
    title: 'A ticket',
    body: 'Body',
    status: 'backlog',
    priority: 'P2',
    assignee: 'steve',
    isEpic: false,
    epicId: 3,
    refined: false,
    maxTurns: null,
    projectId: 1,
  } as unknown as AgentTicket;
  const edit = (overrides: Partial<TicketFormState> = {}) => ({ ...ticketToForm(existing, 1), ...overrides });
  const labels = (f: TicketFormState, e: AgentTicket = existing) => saveChecks(e, f).map((c) => c.label);

  it('names only the write itself for a plain edit', () => {
    expect(labels(edit({ title: 'Renamed' }))).toEqual(['Saving changes']);
  });

  it('names the Queue gate when robot work enters the Queue', () => {
    expect(labels(edit({ status: 'queue', assignee: 'robot' }))[0]).toMatch(/^Queue gate/);
  });

  it('does not re-judge a ticket already in the Robot Queue under the same Epic', () => {
    const queued = { ...existing, status: 'queue', assignee: 'robot' } as AgentTicket;
    expect(labels(ticketToForm(queued, 1), queued)).toEqual(['Saving changes']);
  });

  it('names the refined choice only when a refined ticket’s description changes', () => {
    const refined = { ...existing, refined: true } as AgentTicket;
    expect(labels({ ...ticketToForm(refined, 1), body: 'New body' }, refined)[0]).toMatch(/^Refinement/);
    expect(labels(ticketToForm(refined, 1), refined)).toEqual(['Saving changes']);
  });

  it('puts minting a drafted Epic first, client-side, then the Epic rules', () => {
    const checks = saveChecks(existing, edit({ newEpic: { title: 'Fresh', priority: 'P1' } }));
    expect(checks[0]).toEqual({ stage: 'mint', label: 'Creating the Epic “Fresh”' });
    expect(checks.map((c) => c.label)).toContain('Epic rules — membership, and pausing a refined Epic it joins');
  });

  it('names the cascade when an Epic’s priority changes', () => {
    const epic = { ...existing, isEpic: true, epicId: null } as AgentTicket;
    expect(labels({ ...ticketToForm(epic, 1), priority: 'P0' }, epic)).toEqual([
      'Priority — cascading to every member',
      'Saving changes',
    ]);
  });
});
