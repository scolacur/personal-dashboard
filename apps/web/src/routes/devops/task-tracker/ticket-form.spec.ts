import { describe, it, expect } from 'vitest';
import { ROBOT_MAX_TURNS_LIMIT } from '@dashboard/shared';
import {
  emptyTicketForm,
  epicRequired,
  maxTurnsInvalid,
  ticketFormError,
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
