import { describe, it, expect } from 'vitest';
import type { EvaluatorReport } from '@dashboard/shared';
import { MAX_EVALUATION_ROUNDS, blockingFindings, normalizeReport, parseEvaluatorReport, reworkBrief } from './verdict';

const finding = (over: Partial<EvaluatorReport['findings'][number]> = {}) => ({
  kind: 'correctness' as const,
  blocking: true,
  where: 'apps/server/src/x.ts:10',
  what: 'off-by-one in the page cursor',
  ...over,
});

describe('parseEvaluatorReport', () => {
  it('parses a bare JSON object', () => {
    const r = parseEvaluatorReport('{"verdict":"ship","summary":"looks good","findings":[]}');
    expect(r).toEqual({ verdict: 'ship', summary: 'looks good', findings: [] });
  });

  it('parses a fenced object with prose around it', () => {
    const text = 'Here is my review.\n```json\n{"verdict":"escalate","summary":"ticket is wrong","findings":[]}\n```\nDone.';
    expect(parseEvaluatorReport(text)?.verdict).toBe('escalate');
  });

  it('returns null on an unparseable reply — which is NOT the same as ship', () => {
    // The failure direction that matters: a broken Evaluator must never be indistinguishable from a
    // satisfied one. The caller records the failure and leaves the PR alone.
    expect(parseEvaluatorReport('I could not complete the review.')).toBeNull();
    expect(parseEvaluatorReport('{"verdict":"looks-fine"}')).toBeNull();
    expect(parseEvaluatorReport('')).toBeNull();
  });

  it('drops a finding with no statement of the defect', () => {
    const r = parseEvaluatorReport('{"verdict":"ship","summary":"s","findings":[{"kind":"correctness","what":""}]}');
    expect(r?.findings).toEqual([]);
  });

  it('defaults an omitted `blocking` to false so it cannot trigger a rework by accident', () => {
    // The expensive action must require the model to have said so explicitly.
    const r = parseEvaluatorReport('{"verdict":"ship","summary":"s","findings":[{"kind":"test-gap","what":"no test"}]}');
    expect(r?.findings[0].blocking).toBe(false);
  });

  it('falls back to a known kind rather than dropping an otherwise usable finding', () => {
    const r = parseEvaluatorReport('{"verdict":"ship","summary":"s","findings":[{"kind":"vibes","what":"odd"}]}');
    expect(r?.findings[0].kind).toBe('correctness');
  });

  it('keeps insteadUse on a redundancy finding', () => {
    const r = parseEvaluatorReport(
      '{"verdict":"ship","summary":"s","findings":[{"kind":"redundancy","what":"new helper","insteadUse":"packages/shared/fmt"}]}',
    );
    expect(r?.findings[0].insteadUse).toBe('packages/shared/fmt');
  });
});

describe('normalizeReport', () => {
  it('downgrades a revise carrying no blocking finding to ship', () => {
    // Prose and structured output disagreed. Sending a ticket back with nothing actionable produces
    // a rework pass that cannot succeed, so the cheap reading wins.
    const r = normalizeReport({ verdict: 'revise', summary: 'some nits', findings: [finding({ blocking: false })] });
    expect(r.verdict).toBe('ship');
    expect(r.findings).toHaveLength(1);
    expect(r.summary).toMatch(/downgraded to ship/i);
  });

  it('leaves a ship carrying blocking findings alone', () => {
    // Upgrading would let a mislabelled nitpick trigger rework — the same unactionable outcome from
    // the other direction. Recorded for the human instead.
    const r = normalizeReport({ verdict: 'ship', summary: 's', findings: [finding()] });
    expect(r.verdict).toBe('ship');
  });

  it('leaves a well-formed revise alone', () => {
    const r = normalizeReport({ verdict: 'revise', summary: 's', findings: [finding()] });
    expect(r.verdict).toBe('revise');
  });

  it('applies through parseEvaluatorReport, not just when called directly', () => {
    const r = parseEvaluatorReport('{"verdict":"revise","summary":"s","findings":[{"kind":"convention","what":"nit"}]}');
    expect(r?.verdict).toBe('ship');
  });
});

describe('reworkBrief', () => {
  it('reads as an instruction to the Robot and says it is not the human review', () => {
    const brief = reworkBrief({ verdict: 'revise', summary: 's', findings: [finding()] });
    expect(brief).toMatch(/MUST FIX/);
    expect(brief).toMatch(/not a human review/i);
    expect(brief).toContain('off-by-one in the page cursor');
  });

  it('names the existing thing to use on a redundancy finding', () => {
    const brief = reworkBrief({
      verdict: 'revise',
      summary: 's',
      findings: [finding({ kind: 'redundancy', what: 'adds formatBytes', insteadUse: 'packages/shared/fmt' })],
    });
    expect(brief).toContain('packages/shared/fmt');
  });

  it('separates advisory findings from the blocking ones', () => {
    const brief = reworkBrief({
      verdict: 'revise',
      summary: 's',
      findings: [finding(), finding({ blocking: false, what: 'could be tidier' })],
    });
    expect(brief.indexOf('MUST FIX')).toBeLessThan(brief.indexOf('not blocking'));
    expect(brief).toContain('could be tidier');
  });

  it('tells the Robot to reuse the same PR', () => {
    // Step 0 already covers this, but the brief arrives before Step 0 is acted on and a second PR
    // would strand the first.
    const brief = reworkBrief({ verdict: 'revise', summary: 's', findings: [finding()] });
    expect(brief).toMatch(/do not open a second one/i);
  });
});

describe('blockingFindings', () => {
  it('selects only the blocking ones', () => {
    const report: EvaluatorReport = {
      verdict: 'revise',
      summary: 's',
      findings: [finding(), finding({ blocking: false })],
    };
    expect(blockingFindings(report)).toHaveLength(1);
  });
});

describe('the round cap', () => {
  it('is small, because it exists to terminate a feedback loop rather than to ration', () => {
    expect(MAX_EVALUATION_ROUNDS).toBeLessThanOrEqual(3);
    expect(MAX_EVALUATION_ROUNDS).toBeGreaterThanOrEqual(1);
  });
});
