import { describe, it, expect } from 'vitest';
import type { AgentRun, TicketEvent } from '@dashboard/shared';
import { ROBOT_EVENT } from '@dashboard/shared';
import {
  STATUS_ACTION_REGISTRY,
  isStatusActionState,
  buildStatusContent,
  parkReason,
  askQuestion,
  cumulativeTurns,
  latestRun,
} from './status-action';

function run(partial: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    ticketId: 10,
    issueNumber: null,
    branch: 'robot/x',
    status: 'error',
    sessionId: null,
    prUrl: null,
    error: null,
    faultTier: null,
    faultSignature: null,
    faultReason: null,
    turns: null,
    tokens: null,
    outputTail: null,
    wipRef: null,
    wipSha: null,
    startedAt: 1000,
    finishedAt: null,
    ...partial,
  };
}

function event(type: string, detail: unknown, id = 1): TicketEvent {
  return { id, ticketId: 10, type, detail, createdAt: id * 1000 };
}

describe('STATUS_ACTION_REGISTRY', () => {
  it('covers exactly the input-needed states', () => {
    expect(Object.keys(STATUS_ACTION_REGISTRY).sort()).toEqual(
      ['awaiting-human', 'needs-human', 'stuck'].sort(),
    );
  });

  it('every entry carries a title, description and words config', () => {
    for (const entry of Object.values(STATUS_ACTION_REGISTRY)) {
      expect(entry!.title).toBeTruthy();
      expect(entry!.description).toBeTruthy();
      expect(entry!.words.label).toBeTruthy();
      expect(entry!.words.emptyFallback).toBeTruthy();
    }
  });

  it('maps each state to its expected actions', () => {
    expect(STATUS_ACTION_REGISTRY.stuck!.actions.map((a) => a.kind)).toEqual(['unstick', 'reset']);
    expect(STATUS_ACTION_REGISTRY['needs-human']!.actions.map((a) => a.kind)).toEqual([
      'open-pr',
      'reset',
    ]);
    // awaiting-human has no buttons — it uses the reply box instead.
    expect(STATUS_ACTION_REGISTRY['awaiting-human']!.actions).toEqual([]);
    expect(STATUS_ACTION_REGISTRY['awaiting-human']!.reply).toBe(true);
  });
});

describe('isStatusActionState', () => {
  it('is true for the input-needed states', () => {
    expect(isStatusActionState('stuck')).toBe(true);
    expect(isStatusActionState('awaiting-human')).toBe(true);
    expect(isStatusActionState('needs-human')).toBe(true);
  });

  it('is false for other states and nullish', () => {
    expect(isStatusActionState('working')).toBe(false);
    expect(isStatusActionState('queued')).toBe(false);
    expect(isStatusActionState('in-review')).toBe(false);
    expect(isStatusActionState('done')).toBe(false);
    expect(isStatusActionState('wontfix')).toBe(false);
    expect(isStatusActionState(null)).toBe(false);
    expect(isStatusActionState(undefined)).toBe(false);
  });
});

describe('latestRun / cumulativeTurns', () => {
  it('latestRun returns the first (newest-first) run or null', () => {
    expect(latestRun([])).toBeNull();
    const newest = run({ id: 3 });
    expect(latestRun([newest, run({ id: 2 })])).toBe(newest);
  });

  it('cumulativeTurns sums turns, treating null as zero', () => {
    expect(cumulativeTurns([])).toBe(0);
    expect(cumulativeTurns([run({ turns: 30 }), run({ turns: null }), run({ turns: 12 })])).toBe(42);
  });
});

describe('askQuestion', () => {
  it('returns the newest ask_human question', () => {
    const events = [
      event(ROBOT_EVENT.askHuman, { question: 'old?' }, 1),
      event(ROBOT_EVENT.dispatched, {}, 2),
      event(ROBOT_EVENT.askHuman, { question: 'which db?' }, 3),
    ];
    expect(askQuestion(events)).toBe('which db?');
  });

  it('ignores a blank question and returns null when none', () => {
    expect(askQuestion([event(ROBOT_EVENT.askHuman, { question: '   ' })])).toBeNull();
    expect(askQuestion([event(ROBOT_EVENT.dispatched, {})])).toBeNull();
    expect(askQuestion([])).toBeNull();
  });
});

describe('parkReason', () => {
  it('reports a closed-unmerged PR with its number', () => {
    expect(parkReason([event(ROBOT_EVENT.prClosed, { prNumber: 42 })], [])).toBe(
      'PR #42 was closed without merging.',
    );
  });

  it('reports an explicit park reason, then a stall, newest-first', () => {
    expect(parkReason([event(ROBOT_EVENT.parked, { reason: 'retry cap hit' })], [])).toBe(
      'retry cap hit',
    );
    expect(parkReason([event(ROBOT_EVENT.stalled, { reason: 'no output' })], [])).toBe(
      'Stalled run: no output',
    );
  });

  it('falls back to the latest run fault reason when no park event exists', () => {
    expect(parkReason([], [run({ faultReason: 'lint failed' })])).toBe('lint failed');
  });

  it('returns null when nothing explains the park', () => {
    expect(parkReason([], [])).toBeNull();
    expect(parkReason([event(ROBOT_EVENT.dispatched, {})], [run()])).toBeNull();
  });
});

describe('buildStatusContent', () => {
  it('stuck: surfaces the collapsed output tail, run stats and reason', () => {
    const runs = [run({ outputTail: 'tail text', turns: 50, prUrl: 'http://pr/1' })];
    const events = [event(ROBOT_EVENT.parked, { reason: 'gave up' })];
    const c = buildStatusContent(STATUS_ACTION_REGISTRY.stuck!, runs, events);
    expect(c.words).toBe('tail text');
    expect(c.wordsCollapsed).toBe(true);
    expect(c.reason).toBe('gave up');
    expect(c.runCount).toBe(1);
    expect(c.totalTurns).toBe(50);
    expect(c.actions.map((a) => a.kind)).toEqual(['unstick', 'reset']);
    expect(c.reply).toBe(false);
  });

  it('awaiting-human: surfaces the ask_human question inline and enables the reply box', () => {
    const events = [event(ROBOT_EVENT.askHuman, { question: 'rename or keep?' })];
    const c = buildStatusContent(STATUS_ACTION_REGISTRY['awaiting-human']!, [], events);
    expect(c.words).toBe('rename or keep?');
    expect(c.wordsCollapsed).toBe(false);
    expect(c.reply).toBe(true);
    expect(c.actions).toEqual([]);
  });

  it('needs-human: exposes the PR url for the Open PR action', () => {
    const runs = [run({ prUrl: 'http://pr/9', outputTail: 'closed', turns: 12 })];
    const events = [event(ROBOT_EVENT.prClosed, { prNumber: 9 })];
    const c = buildStatusContent(STATUS_ACTION_REGISTRY['needs-human']!, runs, events);
    expect(c.prUrl).toBe('http://pr/9');
    expect(c.reason).toBe('PR #9 was closed without merging.');
    expect(c.actions.map((a) => a.kind)).toEqual(['open-pr', 'reset']);
  });

  it('a missing field falls back gracefully (no runs, no events)', () => {
    const c = buildStatusContent(STATUS_ACTION_REGISTRY.stuck!, [], []);
    expect(c.words).toBeNull();
    expect(c.wordsFallback).toBeTruthy();
    expect(c.reason).toBeNull();
    expect(c.prUrl).toBeNull();
    expect(c.runCount).toBe(0);
    expect(c.totalTurns).toBe(0);
    // Actions are still present even with no data to show.
    expect(c.actions.map((a) => a.kind)).toEqual(['unstick', 'reset']);
  });
});
