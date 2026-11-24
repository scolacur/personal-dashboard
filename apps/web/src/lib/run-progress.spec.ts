import { describe, it, expect } from 'vitest';
import type { AgentRun, TicketEvent } from '@dashboard/shared';
import { ROBOT_EVENT } from '@dashboard/shared';
import { progressChecksForRun } from './run-progress';

/** PD-964 (D-114): progress checks placed on the run they belong to. */

function run(startedAt: number, finishedAt: number | null): AgentRun {
  return {
    id: startedAt,
    ticketId: 1,
    issueNumber: null,
    branch: 'robot/1',
    status: finishedAt ? 'checkpoint' : 'running',
    sessionId: null,
    prUrl: null,
    error: null,
    faultTier: null,
    faultSignature: null,
    faultReason: null,
    turns: null,
    tokens: null,
    outputTail: null,
    statusReport: null,
    wipRef: null,
    wipSha: null,
    startedAt,
    finishedAt,
  };
}
const check = (at: number, detail: object): TicketEvent => ({ id: at, ticketId: 1, type: ROBOT_EVENT.progressCheck, detail, createdAt: at });

describe('progressChecksForRun', () => {
  const events = [
    check(150, { checkedBy: 'judge', progress: 'progressing', window: 1, turnsSoFar: 26 }),
    check(180, { checkedBy: 'judge', progress: 'stalled', reason: 'loops', window: 2, turnsSoFar: 52 }),
    check(250, { checkedBy: 'total_cap', progress: 'progressing', window: 8, turnsSoFar: 200 }),
    { id: 9, ticketId: 1, type: ROBOT_EVENT.dispatched, detail: {}, createdAt: 160 },
  ];

  it('keeps only checks inside the run, oldest first, marking which ones it carried on after', () => {
    const checks = progressChecksForRun(run(100, 200), events);
    expect(checks.map((c) => [c.verdict, c.passed])).toEqual([
      ['progressing', true],
      ['stalled', false],
    ]);
    expect(checks[1].line).toBe('window 2 at 52 turns: judge says stalled — loops');
  });

  it('a total-cap check never counts as passed, even though the run was progressing', () => {
    const [c] = progressChecksForRun(run(240, 260), events);
    expect(c).toMatchObject({ verdict: 'progressing', passed: false });
  });

  it('a running run collects checks up to now', () => {
    expect(progressChecksForRun(run(100, null), events, 170)).toHaveLength(1);
  });
});
