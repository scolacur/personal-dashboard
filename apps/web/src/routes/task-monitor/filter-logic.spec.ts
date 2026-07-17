import { describe, it, expect } from 'vitest';
import { ticketMatchesQuery, ticketMatchesRefineFilter } from './filter-logic';
import type { AgentTicket } from '@dashboard/shared';

function makeTicket(overrides: Partial<AgentTicket> = {}): AgentTicket {
  return {
    id: 1,
    displayId: 'PD-1',
    projectId: 1,
    title: 'Example ticket',
    body: null,
    status: 'backlog',
    priority: null,
    assignee: null,
    recurInterval: null,
    source: 'manual',
    sortOrder: 0,
    githubIssueNumber: null,
    githubIssueUrl: null,
    agentState: null,
    refineState: null,
    refined: false,
    isEpic: false,
    epicId: null,
    ready: false,
    readyBypassed: false,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('ticketMatchesQuery', () => {
  it('returns true for empty query', () => {
    expect(ticketMatchesQuery(makeTicket(), '')).toBe(true);
    expect(ticketMatchesQuery(makeTicket(), '   ')).toBe(true);
  });

  it('matches by title', () => {
    const t = makeTicket({ title: 'Fix login bug' });
    expect(ticketMatchesQuery(t, 'login')).toBe(true);
    expect(ticketMatchesQuery(t, 'signup')).toBe(false);
  });

  it('matches by body', () => {
    const t = makeTicket({ body: 'Steps to reproduce the crash' });
    expect(ticketMatchesQuery(t, 'crash')).toBe(true);
  });

  it('matches by displayId', () => {
    const t = makeTicket({ displayId: 'PD-171' });
    expect(ticketMatchesQuery(t, 'PD-171')).toBe(true);
    expect(ticketMatchesQuery(t, 'pd-171')).toBe(true);
  });

  it('matches partial displayId', () => {
    const t = makeTicket({ displayId: 'C-5' });
    expect(ticketMatchesQuery(t, 'C-5')).toBe(true);
    expect(ticketMatchesQuery(t, 'c-5')).toBe(true);
  });

  it('does not match unrelated displayId', () => {
    const t = makeTicket({ displayId: 'PD-10', title: 'Some ticket', body: null });
    expect(ticketMatchesQuery(t, 'PD-20')).toBe(false);
  });

  it('handles null displayId without throwing', () => {
    const t = makeTicket({ displayId: null });
    expect(ticketMatchesQuery(t, 'PD-1')).toBe(false);
  });

  it('is case-insensitive', () => {
    const t = makeTicket({ title: 'Music Tracker' });
    expect(ticketMatchesQuery(t, 'MUSIC')).toBe(true);
  });
});

describe('ticketMatchesRefineFilter', () => {
  it('"all" matches every ticket regardless of refine state', () => {
    expect(ticketMatchesRefineFilter(makeTicket({ refined: false, refineState: null }), 'all')).toBe(true);
    expect(ticketMatchesRefineFilter(makeTicket({ refined: true, refineState: null }), 'all')).toBe(true);
    expect(ticketMatchesRefineFilter(makeTicket({ refined: false, refineState: 'refining' }), 'all')).toBe(true);
  });

  it('"refined" matches only refined tickets', () => {
    expect(ticketMatchesRefineFilter(makeTicket({ refined: true }), 'refined')).toBe(true);
    expect(ticketMatchesRefineFilter(makeTicket({ refined: false }), 'refined')).toBe(false);
  });

  it('"refining" matches only tickets with refineState refining', () => {
    expect(ticketMatchesRefineFilter(makeTicket({ refineState: 'refining' }), 'refining')).toBe(true);
    expect(ticketMatchesRefineFilter(makeTicket({ refineState: 'awaiting-human' }), 'refining')).toBe(false);
    expect(ticketMatchesRefineFilter(makeTicket({ refineState: null }), 'refining')).toBe(false);
  });

  it('"awaiting-human" matches only tickets with refineState awaiting-human', () => {
    expect(ticketMatchesRefineFilter(makeTicket({ refineState: 'awaiting-human' }), 'awaiting-human')).toBe(true);
    expect(ticketMatchesRefineFilter(makeTicket({ refineState: 'refining' }), 'awaiting-human')).toBe(false);
    expect(ticketMatchesRefineFilter(makeTicket({ refineState: null }), 'awaiting-human')).toBe(false);
  });

  it('"unrefined" matches tickets that are not refined and have no active refine session', () => {
    expect(ticketMatchesRefineFilter(makeTicket({ refined: false, refineState: null }), 'unrefined')).toBe(true);
    expect(ticketMatchesRefineFilter(makeTicket({ refined: true, refineState: null }), 'unrefined')).toBe(false);
    expect(ticketMatchesRefineFilter(makeTicket({ refined: false, refineState: 'refining' }), 'unrefined')).toBe(false);
    expect(ticketMatchesRefineFilter(makeTicket({ refined: false, refineState: 'awaiting-human' }), 'unrefined')).toBe(false);
  });
});
