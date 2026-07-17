import { describe, it, expect } from 'vitest';
import { buildCopyText } from './copy-utils';
import type { AgentProject, AgentTicket } from '@dashboard/shared';

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

function makeProject(overrides: Partial<AgentProject> = {}): AgentProject {
  return {
    id: 1,
    slug: 'personal-dashboard',
    name: 'Personal Dashboard',
    key: 'PD',
    githubRepo: null,
    robotEnabled: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildCopyText', () => {
  it('uses displayId as label when present', () => {
    const ticket = makeTicket({ displayId: 'PD-7', title: 'My ticket', body: null });
    expect(buildCopyText(ticket)).toBe('**[PD-7] My ticket**');
  });

  it('falls back to project key when displayId is null', () => {
    const ticket = makeTicket({ displayId: null, title: 'My ticket', body: null });
    const project = makeProject({ key: 'PD' });
    expect(buildCopyText(ticket, project)).toBe('**[PD] My ticket**');
  });

  it('omits label brackets when both displayId and project key are null', () => {
    const ticket = makeTicket({ displayId: null, title: 'My ticket', body: null });
    const project = makeProject({ key: null });
    expect(buildCopyText(ticket, project)).toBe('**My ticket**');
  });

  it('omits label when no project is provided and displayId is null', () => {
    const ticket = makeTicket({ displayId: null, title: 'My ticket', body: null });
    expect(buildCopyText(ticket)).toBe('**My ticket**');
  });

  it('appends body after a blank line when body is non-null', () => {
    const ticket = makeTicket({ displayId: 'PD-1', title: 'Title', body: 'Details here' });
    expect(buildCopyText(ticket)).toBe('**[PD-1] Title**\n\nDetails here');
  });

  it('omits body section when body is null', () => {
    const ticket = makeTicket({ displayId: 'PD-1', title: 'Title', body: null });
    expect(buildCopyText(ticket)).toBe('**[PD-1] Title**');
  });

  it('prefers displayId over project key when both are set', () => {
    const ticket = makeTicket({ displayId: 'PD-42', title: 'Title', body: null });
    const project = makeProject({ key: 'PD' });
    expect(buildCopyText(ticket, project)).toBe('**[PD-42] Title**');
  });
});
