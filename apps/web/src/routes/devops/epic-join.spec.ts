import { describe, it, expect } from 'vitest';
import type { AgentTicket } from '@dashboard/shared';
import { joinsEpic, joinWriteOpts, planEpicJoin, unrefinedToast } from './epic-join';

function t(o: Partial<AgentTicket> = {}): AgentTicket {
  return {
    id: 1, displayId: 'PD-1', projectId: 1, title: 'T', body: null, status: 'backlog', priority: null,
    assignee: 'robot', recurInterval: null, source: 'manual', sortOrder: 0, githubIssueNumber: null,
    githubIssueUrl: null, agentState: null, maxTurns: null, agentTurns: null, refineState: null,
    refined: false, refineStale: false, isEpic: false, epicId: 10, ready: true, readyBypassed: false,
    archivedAt: null, createdAt: 0, updatedAt: 0, ...o,
  };
}
const epic = (o: Partial<AgentTicket> = {}) =>
  t({ id: 10, displayId: 'PD-10', title: '[Epic] E', isEpic: true, epicId: null, assignee: null, refined: true, ...o });

describe('joinsEpic', () => {
  it('is a create into an Epic', () => expect(joinsEpic(null, 10)).toBe(true));
  it('is a move into a different Epic', () => expect(joinsEpic({ epicId: 11 }, 10)).toBe(true));
  it('is not an edit that stays in the same Epic', () => expect(joinsEpic({ epicId: 10 }, 10)).toBe(false));
  it('is not leaving an Epic, or no Epic at all', () => {
    expect(joinsEpic({ epicId: 10 }, null)).toBe(false);
    expect(joinsEpic(null, undefined)).toBe(false);
  });
});

describe('planEpicJoin', () => {
  it('warns before a ticket joins a refined Epic', () => {
    const plan = planEpicJoin(epic(), [epic()])!;
    expect(plan.epic.displayId).toBe('PD-10');
    expect(plan.pause.needsConfirm).toBe(false);
  });

  it('folds the pause into the same plan when the refined Epic is running', () => {
    const e = epic({ status: 'queue' });
    const queued = t({ id: 2, displayId: 'PD-2', status: 'queue' });
    const running = t({ id: 3, displayId: 'PD-3', status: 'queue', agentState: 'working' });
    const plan = planEpicJoin(e, [e, queued, running])!;
    expect(plan.pause.needsConfirm).toBe(true);
    expect(plan.pause.unarmed.map((m) => m.displayId)).toEqual(['PD-2']);
    expect(plan.pause.inFlight.map((m) => m.displayId)).toEqual(['PD-3']);
  });

  it('does not warn for an Epic that is not refined, or already stale', () => {
    expect(planEpicJoin(epic({ refined: false }), [])).toBeNull();
    expect(planEpicJoin(epic({ refined: false, refineStale: true }), [])).toBeNull();
  });

  it('does not warn when there is no Epic', () => {
    expect(planEpicJoin(null, [])).toBeNull();
    expect(planEpicJoin(undefined, [])).toBeNull();
  });
});

describe('joinWriteOpts', () => {
  const running = planEpicJoin(epic({ status: 'queue' }), [t({ id: 2, status: 'queue' })]);
  const idle = planEpicJoin(epic(), []);

  it('declines the pause only when asked and there is a pause to decline', () => {
    expect(joinWriteOpts(running, { reRefine: false, keepRunning: true })).toEqual({ keepEpicRunning: true });
    expect(joinWriteOpts(running, { reRefine: false, keepRunning: false })).toEqual({});
    expect(joinWriteOpts(idle, { reRefine: true, keepRunning: true })).toEqual({});
    expect(joinWriteOpts(null, null)).toEqual({});
  });

  it('never carries a "keep refined" option: there is no such field to send (D-089 §3)', () => {
    expect(Object.keys(joinWriteOpts(running, { reRefine: true, keepRunning: true }))).toEqual(['keepEpicRunning']);
  });
});

describe('unrefinedToast', () => {
  it('names the Epic and the way back', () => {
    expect(unrefinedToast({ displayId: 'PD-10', title: 'x' })).toContain('Epic PD-10 now needs re-refinement');
  });
});
