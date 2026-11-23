import { EVALUATOR_VERDICTS, SECURITY_FINDING_KINDS, type EvaluatorFinding, type EvaluatorReport, type EvaluatorVerdict } from '@dashboard/shared';

/**
 * Parsing and bounding the Evaluator's output (PD-487, [[D-076]]).
 *
 * Pure, and separated from the session for the usual reason: every rule here is a decision about
 * what to do with a model's imperfect output, and those are exactly the cases worth testing
 * exhaustively without spawning an agent.
 */

/**
 * How many times one ticket may be evaluated before the Evaluator stops having an opinion.
 *
 * **This is loop safety, not thrift.** A `revise` routes the ticket back to the Robot, which reworks
 * and hands off again, which invites another evaluation — so without a cap, an Evaluator that keeps
 * finding the same thing (or a Robot that cannot satisfy it) is an unbounded rework cycle burning
 * budget on both sides. This is the PD-420 failure mode reached by a new road, and the same lesson
 * as the fault-tier retry caps: any loop where output feeds back into input needs a counter.
 *
 * Two rounds, because the first `revise` is the useful one. A second gives the Robot one chance to
 * respond to it; a third has, in practice, never been a different opinion.
 *
 * **This is now only the DEFAULT** (PD-761). The live cap is `EvaluatorConfig.maxRounds`, read from
 * `EVALUATOR_MAX_ROUNDS`, so Steve can raise it once each round is cheap (PD-419) without a code
 * change. Both review paths consume the configured value; this constant is the fallback.
 */
export const MAX_EVALUATION_ROUNDS = 2;

/** Bound on the diff handed to the Evaluator. A PR larger than this is not read carefully by any
 *  reviewer, human or otherwise — it is truncated with an explicit note rather than silently. */
export const MAX_DIFF_CHARS = 120_000;

/**
 * How much of an unparseable reply is kept on the run's `error` (PD-883). The old 500-char slice
 * threw away the tail — which, for a reply that failed to parse, is exactly where the malformed JSON
 * or the truncation usually is. 20k is generous enough to hold a whole over-long reply while still
 * bounding a pathological one. */
export const MAX_UNPARSEABLE_CHARS = 20_000;

const FINDING_KINDS: readonly EvaluatorFinding['kind'][] = [
  'ac-unmet',
  'out-of-scope',
  'redundancy',
  'test-gap',
  'correctness',
  'convention',
  'readability',
  ...SECURITY_FINDING_KINDS,
];

function isVerdict(v: unknown): v is EvaluatorVerdict {
  return typeof v === 'string' && (EVALUATOR_VERDICTS as readonly string[]).includes(v);
}

/** Coerce one raw finding, or null when it carries nothing usable. */
function toFinding(raw: unknown): EvaluatorFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const what = typeof r.what === 'string' ? r.what.trim() : '';
  // A finding with no statement of the defect is unactionable regardless of its other fields.
  if (!what) return null;
  const kind = FINDING_KINDS.includes(r.kind as EvaluatorFinding['kind'])
    ? (r.kind as EvaluatorFinding['kind'])
    : 'correctness';
  return {
    kind,
    // Default to NON-blocking. An omitted `blocking` must not be able to trigger a rework cycle:
    // the expensive action requires the model to have said so explicitly.
    blocking: r.blocking === true,
    where: typeof r.where === 'string' ? r.where : '',
    what,
    ...(typeof r.insteadUse === 'string' && r.insteadUse.trim() ? { insteadUse: r.insteadUse.trim() } : {}),
  };
}

/**
 * Collect every top-level balanced `{…}` substring in `text`, in order.
 *
 * The scan is **string-aware**: braces that fall inside a double-quoted JSON string (honouring
 * backslash escapes) do not change nesting depth. This is what lets a security summary that quotes
 * `${...}` template literals or arbitrary code sit in a `summary` value without corrupting the walk —
 * the naïve `indexOf('{')…lastIndexOf('}')` slice this replaced was defeated by exactly that
 * (PD-853 defect #1).
 */
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Extract the Evaluator's report object from its reply — the **last** top-level `{…}` that both
 * `JSON.parse`s and carries a valid `verdict`, scanning candidates from the end (PD-853 defect #1).
 *
 * The doc-comment on the old implementation claimed it extracted "the last JSON object"; it did not —
 * it sliced from the *first* `{` to the *last* `}`, so any `{` in the prose before the real report
 * (e.g. a security review discussing `${...}` SQL) moved the slice start too early and `JSON.parse`
 * threw, stranding the PR. This selects by validity instead of position: of all balanced candidates,
 * the last one that is a parseable object with a known verdict wins.
 *
 * A ```json (or bare ```) fence is preferred when present — but when there are several fenced blocks,
 * or several objects, the same "last that parses with a valid verdict" rule applies rather than
 * assuming the first.
 */
function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  // Prefer fenced content when any fence exists; otherwise scan the whole reply.
  const scanTargets = fences.length > 0 ? fences : [text];
  const candidates = scanTargets.flatMap(topLevelObjects);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && isVerdict((parsed as Record<string, unknown>).verdict)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Parse the Evaluator's reply into a report, or null when there is nothing usable.
 *
 * **Null means "the evaluation did not happen", which is deliberately different from `ship`.** An
 * unparseable reply is an infrastructure failure, and treating it as approval would make a broken
 * Evaluator silently indistinguishable from a satisfied one — the worst possible failure direction
 * for a reviewer. The caller records it and leaves the PR alone.
 */
export function parseEvaluatorReport(text: string): EvaluatorReport | null {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!isVerdict(obj.verdict)) return null;

  const findings = Array.isArray(obj.findings)
    ? obj.findings.map(toFinding).filter((f): f is EvaluatorFinding => f !== null)
    : [];
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  // PD-773: an optional request for Steve's visual check. Never changes the verdict.
  const visualReview = typeof obj.visualReview === 'string' && obj.visualReview.trim() !== '' ? obj.visualReview.trim().slice(0, 500) : undefined;

  return normalizeReport({ verdict: obj.verdict, findings, summary, ...(visualReview ? { visualReview } : {}) });
}

/**
 * Reconcile a verdict with the findings that are supposed to justify it.
 *
 * The rubric says a `revise` must carry a blocking finding. When it does not, the honest reading is
 * that the Evaluator's prose and its structured output disagree — and the resolution must not be to
 * trust the expensive one. A `revise` with nothing blocking is **downgraded to `ship`**, keeping its
 * findings as advisory, because the alternative is sending a ticket back to a Robot with no
 * actionable instruction, which produces a rework pass that cannot succeed.
 *
 * The reverse case — a `ship` carrying blocking findings — is left alone deliberately. Upgrading it
 * would let a mislabelled `blocking: true` on a nitpick trigger rework, which is the same
 * unactionable outcome from the other direction. The findings are recorded and a human sees them.
 */
export function normalizeReport(report: EvaluatorReport): EvaluatorReport {
  const blocking = report.findings.filter((f) => f.blocking);
  if (report.verdict === 'revise' && blocking.length === 0) {
    return {
      ...report,
      verdict: 'ship',
      findings: report.findings,
      summary: report.summary
        ? `${report.summary}\n\n(Verdict downgraded to ship: the Evaluator returned "revise" with no blocking finding, so there was nothing actionable to send back.)`
        : 'Verdict downgraded to ship: the Evaluator returned "revise" with no blocking finding.',
    };
  }
  return report;
}

/** Findings the Robot must act on. */
export function blockingFindings(report: EvaluatorReport): EvaluatorFinding[] {
  return report.findings.filter((f) => f.blocking);
}

/**
 * The rework instruction a `revise` becomes — the text handed to the Robot on its next pass.
 *
 * Written as an instruction rather than a report because that is what the resume prompt injects: the
 * Robot reads this as its brief, not as commentary about itself. It states the source explicitly so
 * the Robot does not mistake it for the human's review.
 */
export function reworkBrief(report: EvaluatorReport): string {
  const blocking = blockingFindings(report);
  const advisory = report.findings.filter((f) => !f.blocking);
  const lines = [
    'An automated Evaluator reviewed your PR against the ticket and found problems that must be',
    'fixed before a human reviews it. This is not a human review — the human has not looked yet.',
    '',
    'MUST FIX:',
  ];
  for (const f of blocking) {
    const where = f.where ? ` [${f.where}]` : '';
    const instead = f.insteadUse ? ` Use \`${f.insteadUse}\` instead of adding a new one.` : '';
    lines.push(`- (${f.kind})${where} ${f.what}${instead}`);
  }
  if (advisory.length) {
    lines.push('', 'Worth considering, not blocking:');
    for (const f of advisory) {
      const where = f.where ? ` [${f.where}]` : '';
      lines.push(`- (${f.kind})${where} ${f.what}`);
    }
  }
  lines.push(
    '',
    'Fix these on the SAME branch and hand off again as normal (verify → commit → push). The PR',
    'already exists; do not open a second one.',
  );
  return lines.join('\n');
}
