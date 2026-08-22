import { describe, it, expect } from 'vitest';
import { ROBOT_MAX_TURNS_LIMIT } from '@dashboard/shared';
import { emptyTicketForm, maxTurnsInvalid, ticketFormError, type TicketFormState } from './ticket-form';

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

  // D-TMP-PD383a slice C: every Ticket belongs to an Epic.
  it('refuses to CREATE a Ticket with no Epic', () => {
    expect(ticketFormError(form({ epicId: null }), creating)).toMatch(/belongs to an Epic/i);
    expect(ticketFormError(form({ epicId: 7 }), creating)).toBeNull();
  });

  // The board still holds tickets that predate the rule; blocking a typo fix on one would
  // enforce the model against history rather than against new work.
  it('does NOT block editing an existing Epic-less ticket', () => {
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
