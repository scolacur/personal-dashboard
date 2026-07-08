import { describe, it, expect } from 'vitest';
import type { AuditFinding, AuditRun, AuditRunStatus } from '@dashboard/shared';
import {
  isActionable,
  isOpen,
  openActionableFindings,
  pickReportRun,
  latestRun,
  isRunInFlight,
  groupByProjectAndBucket,
} from './audit-logic';

function run(id: number, status: AuditRunStatus): AuditRun {
  return {
    id,
    status,
    scope: null,
    model: null,
    counts: null,
    startedAt: null,
    finishedAt: null,
    createdAt: id,
  };
}

function finding(
  over: Partial<AuditFinding> & Pick<AuditFinding, 'id'>,
): AuditFinding {
  return {
    runId: 1,
    projectId: 1,
    ticketId: 100 + over.id,
    type: 'archive',
    recommendation: null,
    reason: null,
    evidence: null,
    proposedChange: null,
    confidence: null,
    decision: 'undecided',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('actionable / open filters', () => {
  it('treats every bucket except "keep" as actionable', () => {
    expect(isActionable(finding({ id: 1, type: 'archive' }))).toBe(true);
    expect(isActionable(finding({ id: 2, type: 'complete' }))).toBe(true);
    expect(isActionable(finding({ id: 3, type: 'reprioritize' }))).toBe(true);
    expect(isActionable(finding({ id: 4, type: 'keep' }))).toBe(false);
  });

  it('open means the decision is still undecided', () => {
    expect(isOpen(finding({ id: 1, decision: 'undecided' }))).toBe(true);
    expect(isOpen(finding({ id: 2, decision: 'accepted' }))).toBe(false);
    expect(isOpen(finding({ id: 3, decision: 'rejected' }))).toBe(false);
  });

  it('openActionableFindings keeps only undecided + actionable', () => {
    const findings = [
      finding({ id: 1, type: 'archive', decision: 'undecided' }), // keep
      finding({ id: 2, type: 'keep', decision: 'undecided' }), // drop: not actionable
      finding({ id: 3, type: 'complete', decision: 'accepted' }), // drop: decided
      finding({ id: 4, type: 'update', decision: 'undecided' }), // keep
    ];
    expect(openActionableFindings(findings).map((f) => f.id)).toEqual([1, 4]);
  });
});

describe('run selection', () => {
  it('pickReportRun returns the most recent DONE run', () => {
    const runs = [run(5, 'running'), run(4, 'done'), run(3, 'done'), run(2, 'error')];
    expect(pickReportRun(runs)?.id).toBe(4);
  });

  it('pickReportRun is null until a run completes', () => {
    expect(pickReportRun([run(2, 'running'), run(1, 'requested')])).toBeNull();
    expect(pickReportRun([])).toBeNull();
  });

  it('does not assume input order (sorts by id desc)', () => {
    const runs = [run(3, 'done'), run(5, 'done'), run(4, 'error')];
    expect(pickReportRun(runs)?.id).toBe(5);
    expect(latestRun(runs)?.id).toBe(5);
  });

  it('isRunInFlight is true only for requested/running', () => {
    expect(isRunInFlight(run(1, 'requested'))).toBe(true);
    expect(isRunInFlight(run(1, 'running'))).toBe(true);
    expect(isRunInFlight(run(1, 'done'))).toBe(false);
    expect(isRunInFlight(run(1, 'error'))).toBe(false);
    expect(isRunInFlight(null)).toBe(false);
  });
});

describe('groupByProjectAndBucket', () => {
  it('groups project → bucket, projects id-asc (null last), buckets alpha, findings id-asc', () => {
    const groups = groupByProjectAndBucket([
      finding({ id: 3, projectId: 2, type: 'update' }),
      finding({ id: 1, projectId: 1, type: 'complete' }),
      finding({ id: 2, projectId: 1, type: 'archive' }),
      finding({ id: 5, projectId: 1, type: 'archive' }),
      finding({ id: 4, projectId: null, type: 'archive' }),
    ]);

    expect(groups.map((g) => g.projectId)).toEqual([1, 2, null]);

    const p1 = groups[0];
    expect(p1.buckets.map((b) => b.type)).toEqual(['archive', 'complete']);
    expect(p1.buckets[0].findings.map((f) => f.id)).toEqual([2, 5]);
  });

  it('returns an empty array for no findings', () => {
    expect(groupByProjectAndBucket([])).toEqual([]);
  });
});
