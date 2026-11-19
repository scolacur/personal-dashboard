import { describe, it, expect } from 'vitest';
import type { EvaluatorReport } from '@dashboard/shared';
import { loadConfig } from '../../shared/config';
import { codingEnv } from '../robot/session';
import { gateForOutcome, gateReviewing, gateTargetUrl } from './review-gate';

const report = (verdict: EvaluatorReport['verdict']): EvaluatorReport => ({ verdict, summary: 's', findings: [] });

describe('review-gate mapping (PD-763)', () => {
  it('ship is the only success', () => {
    expect(gateForOutcome(report('ship'), 1, 2)).toEqual({ state: 'success', description: 'Evaluator: ship (round 1)' });
  });

  it('a revise that sends the PR back is pending; at the round cap it needs Steve', () => {
    expect(gateForOutcome(report('revise'), 1, 2).state).toBe('pending');
    expect(gateForOutcome(report('revise'), 2, 2)).toMatchObject({ state: 'failure', description: expect.stringContaining('round cap') });
  });

  it('escalate and a missing verdict both need Steve; a failure is never success (D-076)', () => {
    expect(gateForOutcome(report('escalate'), 1, 2).state).toBe('failure');
    expect(gateForOutcome(null, 1, 2)).toMatchObject({ state: 'failure', description: expect.stringContaining('could not produce') });
  });

  it('is pending while reviewing, and keeps descriptions within GitHub’s 140 characters', () => {
    expect(gateReviewing(3)).toEqual({ state: 'pending', description: 'Evaluator reviewing (round 3)' });
    for (const s of [gateForOutcome(null, 1, 2), gateForOutcome(report('revise'), 99, 2)]) {
      expect(s.description.length).toBeLessThanOrEqual(140);
    }
  });

  it('links to the ticket only when a base URL is configured', () => {
    expect(gateTargetUrl(loadConfig({}), 'PD-1')).toBeNull();
    const c = loadConfig({ REVIEW_GATE_TICKET_URL_BASE: 'http://dash:8088/devops/tickets/' });
    expect(gateTargetUrl(c, 'PD-1')).toBe('http://dash:8088/devops/tickets/PD-1');
    expect(gateTargetUrl(c, null)).toBeNull();
  });
});

describe('the review-gate token never reaches the Robot (PD-763)', () => {
  it('is stripped from the coding session env even when the worker has it', () => {
    const before = process.env.REVIEW_GATE_TOKEN;
    process.env.REVIEW_GATE_TOKEN = 'github_pat_statuses_only';
    try {
      const env = codingEnv(loadConfig({ REVIEW_GATE_TOKEN: 'github_pat_statuses_only', ROBOT_GITHUB_TOKEN: 'ghp_write' }));
      expect(env.REVIEW_GATE_TOKEN).toBeUndefined();
      expect(Object.values(env)).not.toContain('github_pat_statuses_only');
      expect(env.GH_TOKEN).toBe('ghp_write');
    } finally {
      if (before === undefined) delete process.env.REVIEW_GATE_TOKEN;
      else process.env.REVIEW_GATE_TOKEN = before;
    }
  });
});
