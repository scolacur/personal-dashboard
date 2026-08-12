import { describe, it, expect } from 'vitest';
import { evaluatorVerdictLine, ROBOT_EVENT } from '@dashboard/shared';

// Rendered by ActivityTimeline.svelte and (per PD-162) by the Activity Feed. It lives in shared so
// both read the same words; these assert the counts, which are the part that carries meaning.
describe('evaluatorVerdictLine', () => {
  it('says how much work a revise implies, not just that one happened', () => {
    expect(evaluatorVerdictLine({ verdict: 'revise', findings: 3, blockingFindings: 2 })).toBe(
      'revise — 2 blocking findings to fix',
    );
  });

  it('singularises', () => {
    expect(evaluatorVerdictLine({ verdict: 'revise', findings: 1, blockingFindings: 1 })).toContain('1 blocking finding to fix');
  });

  it('distinguishes a clean ship from one carrying advisory notes', () => {
    // The notes are the reason to open the PR and look; collapsing both to "ship" hides that.
    expect(evaluatorVerdictLine({ verdict: 'ship', findings: 0, blockingFindings: 0 })).toBe('ship — no findings');
    expect(evaluatorVerdictLine({ verdict: 'ship', findings: 2, blockingFindings: 0 })).toBe('ship, with 2 advisory notes');
  });

  it('says what an escalate means for the reader', () => {
    expect(evaluatorVerdictLine({ verdict: 'escalate', findings: 0, blockingFindings: 0 })).toMatch(/human decision/);
  });

  it('does not crash on a detail written before these counts existed', () => {
    expect(evaluatorVerdictLine({})).toBe('unknown');
    expect(evaluatorVerdictLine({ verdict: 'ship' })).toBe('ship — no findings');
  });
});

describe('the evaluator event pair', () => {
  it('has a start marker as well as a verdict', () => {
    // A failed evaluation deliberately writes NO verdict, so it must never look like approval.
    // Without a start event that failure would be invisible rather than merely inconclusive.
    expect(ROBOT_EVENT.evaluating).toBe('robot_evaluating');
    expect(ROBOT_EVENT.evaluated).toBe('robot_evaluated');
  });
});
