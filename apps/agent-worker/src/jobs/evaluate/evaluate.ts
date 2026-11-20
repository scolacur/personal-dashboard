import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  buildEvaluatorPrompt,
  evaluatorSystemPrompt,
  ROBOT_EVENT,
  securityEvaluatorSystemPrompt,
  type EvaluatorLens,
  type EvaluatorReport,
} from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { buildContextPack } from '../../shared/context-pack';
import { latestEventAt, logMilestone } from '../robot/events';
import { setAgentState } from '../robot/board';
import { lastHandoffAt } from '../robot/runs';
import { inReviewPrTargets } from '../robot/pr-state';
import { readStateNumber, writeState } from '../robot/state';
import {
  alreadyEvaluated,
  ensureEvaluatorRunsTable,
  evaluationRounds,
  evaluatorBudgetVerdict,
  finishEvaluatorRun,
  startEvaluatorRun,
} from './evaluator-runs';
import { runEvaluatorTurn, type RunEvaluatorTurn } from './evaluate-agent';
// `reworkBrief` is deliberately NOT called here — the brief is derived at dispatch time from the
// recorded findings (`brief.ts`), so the wording the Robot receives always matches the stored
// verdict rather than being a second copy that can drift.
import { MAX_DIFF_CHARS, MAX_EVALUATION_ROUNDS, blockingFindings, parseEvaluatorReport } from './verdict';
import {
  defaultHeadShaFetcher,
  defaultStatusPoster,
  gateForOutcome,
  gateReviewing,
  gateTargetUrl,
  type HeadShaFetcher,
  type StatusPoster,
} from './review-gate';

const run = promisify(execFile);

/**
 * The Evaluator pass (PD-487, [[D-076]]): review each in-review Robot PR against its ticket, record
 * the verdict on the ticket timeline, and send a `revise` back through the loop's existing rework
 * path.
 *
 * **Its verdict feeds the `review-gate` status (D-098, amending D-076).** On its own it still blocks
 * nothing: `review-gate` only gates merging once branch protection requires it (PD-766). With
 * `REVIEW_GATE_TOKEN` unset, no status is posted and this is the advisory reviewer D-076 described.
 *
 * **It runs post-hand-off, as its own process, and that is load-bearing.** An in-session evaluator
 * would be sub-agent-shaped, and sub-agent turns are invisible to `num_turns` — the exact accounting
 * hole D-068/PD-486 closed. Out here it has its own turn cap and its own ledger, so it cannot
 * inflate the run it is judging.
 */

const EVAL_POLL_LAST = 'evaluator_poll_last';

export type DiffFetcher = (repo: string, prNumber: number) => Promise<string | null>;

/**
 * Default diff fetcher: `gh pr diff` with the READ-ONLY token. Read-only by construction — the
 * Evaluator never needs the write token, because its output goes to the DB rather than to GitHub
 * (see `ResumeContext.evaluatorBrief`). Any failure resolves to null: a fetch failure must be a
 * skipped evaluation, never a crashed loop and never an empty diff the agent would misread as
 * "nothing changed".
 */
export function defaultDiffFetcher(config: AgentWorkerConfig): DiffFetcher {
  return async (repo, prNumber) => {
    try {
      const token = config.githubReadToken;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
        ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
      };
      const { stdout } = await run('gh', ['pr', 'diff', String(prNumber), '--repo', repo], {
        env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      logger.warn({ err, repo, prNumber }, 'evaluator: diff fetch failed — skipping this evaluation');
      return null;
    }
  };
}

export interface EvaluatePassDeps {
  runAgent?: RunEvaluatorTurn;
  fetchDiff?: DiffFetcher;
  buildContext?: (checkoutDir: string, onMissing?: (what: string) => void) => string;
  /** PD-763: injectable for tests; default to `gh` with the read / statuses-only tokens. */
  fetchHeadSha?: HeadShaFetcher;
  postStatus?: StatusPoster;
}

interface TicketRow {
  title: string;
  body: string | null;
}

function ticketFor(db: Database.Database, ticketId: number): TicketRow | null {
  const row = db.prepare('SELECT title, body FROM agent_tickets WHERE id = ?').get(ticketId) as
    | { title: string; body: string | null }
    | undefined;
  return row ?? null;
}

/**
 * Where the current review cycle starts: the last hand-off, or a later mechanical conflict
 * resolution (PD-774, D-099). The resolved head is new code on the branch, so it is reviewed again,
 * with a fresh pair of rounds, exactly as a fresh hand-off would be.
 */
export function reviewBoundary(db: Database.Database, ticketId: number): number {
  return Math.max(lastHandoffAt(db, ticketId), latestEventAt(db, ticketId, ROBOT_EVENT.conflictResolved));
}

function displayIdFor(db: Database.Database, ticketId: number): string | null {
  const row = db.prepare('SELECT display_id FROM agent_tickets WHERE id = ?').get(ticketId) as
    | { display_id: string | null }
    | undefined;
  return row?.display_id ?? null;
}

/** Trim an over-long diff, reporting whether it was cut. */
export function capDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true };
}

/**
 * Evaluate one handed-off PR. Returns the report, or null when the evaluation did not produce a
 * usable verdict (fetch failure, agent error, unparseable reply).
 *
 * **A null return never advances the ticket.** An Evaluator that cannot be read must not be
 * indistinguishable from one that approved — so the failure is recorded on its own ledger and the PR
 * is left exactly as the Robot handed it off, awaiting the human who was always going to review it.
 */
export async function evaluateOnePr(
  db: Database.Database,
  config: AgentWorkerConfig,
  target: { ticketId: number; repo: string; prNumber: number },
  deps: EvaluatePassDeps = {},
  now: number = Date.now(),
): Promise<EvaluatorReport | null> {
  const runAgent = deps.runAgent ?? runEvaluatorTurn;
  const fetchDiff = deps.fetchDiff ?? defaultDiffFetcher(config);
  const buildContext = deps.buildContext ?? buildContextPack;

  const ticket = ticketFor(db, target.ticketId);
  if (!ticket) {
    logger.warn({ ticketId: target.ticketId }, 'evaluator: ticket vanished — skipping');
    return null;
  }

  // PD-767: the reviewers this PR gets. Each has its own rubric, ledger rows and round count; they
  // share the diff, the pinned SHA and the decision below.
  const lenses: EvaluatorLens[] = config.evaluator.securityEnabled ? ['code', 'security'] : ['code'];
  const since = reviewBoundary(db, target.ticketId);
  const rounds = new Map(lenses.map((l) => [l, evaluationRounds(db, target.ticketId, since, l) + 1]));
  const round = Math.max(...rounds.values());

  // PD-763: the review-gate status, only when its token is configured. A status failure is logged by
  // the poster and never affects the evaluation.
  const gateOn = config.evaluator.reviewGateToken !== '';
  const postStatus = deps.postStatus ?? defaultStatusPoster(config);
  let gateSha: string | null = null;
  const gate = async (status: ReturnType<typeof gateForOutcome>) => {
    if (gateOn && gateSha) await postStatus(target.repo, gateSha, status, gateTargetUrl(config, displayIdFor(db, target.ticketId)));
  };

  // Written BEFORE the pass, so an evaluation that dies or hangs is legible on the timeline as
  // "reviewing…" with no verdict after it. A failure writes no verdict on purpose (it must never
  // read as approval), which without this marker would make it invisible rather than merely
  // inconclusive.
  const runIds = new Map<EvaluatorLens, number>();
  for (const lens of lenses) {
    const r = rounds.get(lens)!;
    runIds.set(
      lens,
      startEvaluatorRun(db, { ticketId: target.ticketId, prNumber: target.prNumber, round: r, model: config.evaluator.model, lens }, now),
    );
    logMilestone(db, target.ticketId, ROBOT_EVENT.evaluating, { round: r, prNumber: target.prNumber, lens }, now);
  }

  // PD-763: pin the head SHA BEFORE reading the diff. If the Robot pushes mid-review, the verdict
  // lands on the commit that was actually reviewed, and the new commit starts with no gate at all.
  if (gateOn) {
    gateSha = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(target.repo, target.prNumber);
    await gate(gateReviewing(round));
  }

  const rawDiff = await fetchDiff(target.repo, target.prNumber);
  if (rawDiff === null) {
    for (const id of runIds.values()) finishEvaluatorRun(db, id, { error: 'diff fetch failed' }, now);
    await gate(gateForOutcome(null, round, MAX_EVALUATION_ROUNDS));
    return null;
  }
  const { diff, truncated } = capDiff(rawDiff);
  const userPrompt = buildEvaluatorPrompt({ title: ticket.title, body: ticket.body, prNumber: target.prNumber, diff, diffTruncated: truncated });
  const contextPack = buildContext(config.checkoutDir, (what) =>
    logger.warn({ what, ticketId: target.ticketId }, 'evaluator: context source missing — the review is degraded'),
  );

  // Each lens reviews independently. A lens with no usable verdict records its error and yields null.
  const reports = new Map<EvaluatorLens, EvaluatorReport | null>();
  for (const lens of lenses) {
    const runId = runIds.get(lens)!;
    const r = rounds.get(lens)!;
    const system = lens === 'security' ? securityEvaluatorSystemPrompt(contextPack) : evaluatorSystemPrompt(contextPack);
    const result = await runAgent(config, system, userPrompt);
    if (!result.ok) {
      finishEvaluatorRun(db, runId, { error: result.text || 'agent error', turns: result.turns, tokens: result.tokens }, now);
      logger.warn({ ticketId: target.ticketId, lens, error: result.text }, 'evaluator: agent turn failed');
      reports.set(lens, null);
      continue;
    }
    const report = parseEvaluatorReport(result.text);
    if (!report) {
      finishEvaluatorRun(
        db,
        runId,
        { error: `unparseable report: ${result.text.slice(0, 500)}`, turns: result.turns, tokens: result.tokens },
        now,
      );
      logger.warn({ ticketId: target.ticketId, lens }, 'evaluator: reply had no usable verdict — leaving the PR alone');
      reports.set(lens, null);
      continue;
    }
    finishEvaluatorRun(db, runId, { report, turns: result.turns, tokens: result.tokens }, now);
    const blocking = blockingFindings(report);
    // Recorded on EVERY verdict, not just a rejecting one: a timeline that only shows the Evaluator
    // complaining reads as noise, and "it reviewed this and was satisfied" is the thing a human most
    // wants to know before merging.
    logMilestone(
      db,
      target.ticketId,
      ROBOT_EVENT.evaluated,
      {
        verdict: report.verdict,
        findings: report.findings.length,
        blockingFindings: blocking.length,
        round: r,
        prNumber: target.prNumber,
        reason: report.summary,
        lens,
      },
      now,
    );
    // PD-767: a secret in a PR is already public (the repo is public). Say so loudly and at once,
    // whatever the verdict, because the remedy — rotating it — does not wait for the PR.
    const secrets = report.findings.filter((f) => f.kind === 'secret');
    if (lens === 'security' && secrets.length > 0) {
      notifySecretFound(db, target, secrets.map((f) => f.where || 'unknown location'), now);
    }
    reports.set(lens, report);
  }

  // One decision for the PR, from every lens. Any missing verdict means the PR cannot pass (D-076:
  // a failed evaluation is never approval); otherwise the worst verdict wins.
  const all = [...reports.values()];
  const combined: EvaluatorReport | null = all.some((r) => r === null)
    ? null
    : {
        verdict: all.some((r) => r!.verdict === 'escalate') ? 'escalate' : all.some((r) => r!.verdict === 'revise') ? 'revise' : 'ship',
        findings: all.flatMap((r) => r!.findings),
        summary: all.map((r) => r!.summary).join(' '),
      };
  // The round that matters is the highest among the lenses asking for changes.
  const reviseRound = Math.max(0, ...lenses.filter((l) => reports.get(l)?.verdict === 'revise').map((l) => rounds.get(l)!));

  if (combined?.verdict === 'revise') {
    if (reviseRound >= MAX_EVALUATION_ROUNDS) {
      // The cap is the loop-safety limit (see MAX_EVALUATION_ROUNDS). At the ceiling the finding is
      // recorded and the human decides — sending it back again is the unbounded cycle.
      logger.warn(
        { ticketId: target.ticketId, round: reviseRound },
        'evaluator: revise at the round cap — leaving for the human instead of another rework',
      );
    } else {
      setAgentState(db, target.ticketId, 'queued', now);
      logMilestone(
        db,
        target.ticketId,
        ROBOT_EVENT.reactivated,
        { reason: `evaluator requested changes (round ${reviseRound})`, prNumber: target.prNumber },
        now,
      );
      logger.info({ ticketId: target.ticketId, blocking: blockingFindings(combined).length }, 'evaluator: revise → re-queued for rework');
    }
  } else if (combined) {
    logger.info({ ticketId: target.ticketId, verdict: combined.verdict }, 'evaluator: verdict recorded');
  }

  await gate(gateForOutcome(combined, combined?.verdict === 'revise' ? reviseRound : round, MAX_EVALUATION_ROUNDS));
  return combined;
}

/** An urgent Notification Center entry for a secret found in a PR (PD-767). Never carries the value:
 *  the security prompt forbids repeating it, and this names only where it is. */
function notifySecretFound(
  db: Database.Database,
  target: { ticketId: number; prNumber: number },
  where: string[],
  now: number,
): void {
  const displayId = displayIdFor(db, target.ticketId);
  db.prepare('INSERT INTO agent_notifications (kind, ticket_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'agent_needs_human',
    target.ticketId,
    `Possible secret in PR #${target.prNumber}${displayId ? ` (${displayId})` : ''}: rotate it`,
    `The security reviewer found a credential at ${where.join(', ')}. The repo is public, so treat it as leaked: rotate it now, then remove it from the branch.`,
    now,
  );
}

/**
 * One Evaluator poll: evaluate every in-review PR that has not been evaluated since its last
 * hand-off. Returns the number evaluated.
 *
 * Gated four ways, in this order, because each is cheaper than the next: the master switch, the
 * poll interval, the Evaluator's own budget, then per-ticket idempotence.
 */
export async function runEvaluatePass(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: EvaluatePassDeps = {},
): Promise<number> {
  if (!config.evaluator.enabled) return 0;

  const last = readStateNumber(db, EVAL_POLL_LAST);
  if (now - last < config.evaluator.intervalMs) return 0;
  writeState(db, EVAL_POLL_LAST, String(now), now);

  ensureEvaluatorRunsTable(db);

  const budget = evaluatorBudgetVerdict(
    db,
    {
      windowMs: config.evaluator.budgetWindowMs,
      turns: config.evaluator.budgetTurns,
      tokens: config.evaluator.budgetTokens,
    },
    now,
  );
  if (budget.breached) {
    // Its OWN ceiling, so this never pauses dispatch — the Robot loop keeps working while the
    // Evaluator sits out the window. That separation is the point of the separate ledger.
    logger.warn({ reason: budget.reason }, 'evaluator: own budget ceiling reached — not evaluating this window');
    return 0;
  }

  let evaluated = 0;
  for (const target of inReviewPrTargets(db)) {
    const since = reviewBoundary(db, target.ticketId);
    if (alreadyEvaluated(db, target.ticketId, target.prNumber, since)) continue;
    try {
      const report = await evaluateOnePr(db, config, target, deps, now);
      if (report) evaluated++;
    } catch (err) {
      // One bad PR must not strand the rest of the queue.
      logger.error({ err, ticketId: target.ticketId }, 'evaluator: evaluation threw — continuing');
    }
  }
  return evaluated;
}
