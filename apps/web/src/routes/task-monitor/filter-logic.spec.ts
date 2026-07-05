import { describe, it, expect } from 'vitest';
import { ticketMatchesQuery } from './filter-logic';
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
