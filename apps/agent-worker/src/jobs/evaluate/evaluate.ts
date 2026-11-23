import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  buildEvaluatorPrompt,
  evaluatorSystemPrompt,
  ROBOT_EVENT,
  securityEvaluatorSystemPrompt,
  VISUAL_REVIEW_NOTIFICATION_PREFIX,
  type EvaluatorLens,
  type EvaluatorReport,
} from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { buildContextPack } from '../../shared/context-pack';
import { latestEventAt, logMilestone } from '../robot/events';
import { notify } from '../robot/notify';
import { visualGate, visualRequested, VISUAL_PENDING_DESCRIPTION } from '../visual/gate';
import { defaultCommenter } from '../visual/pass';
import { captureOffReleaseKey, recordCaptureOff, type Commenter } from '../visual/status';
import { setAgentState } from '../robot/board';
import { lastHandoffAt } from '../robot/runs';
import { inReviewPrTargets } from '../robot/pr-state';
import { readStateNumber, writeState } from '../robot/state';
import {
  alreadyEvaluated,
  ensureEvaluatorRunsTable,
  evaluatorBudgetVerdict,
  finishEvaluatorRun,
  latestLensReport,
  lensNeedsRun,
  lensStates,
  MAX_LENS_ERROR_RUNS,
  startEvaluatorRun,
  updateEvaluatorRunProgress,
} from './evaluator-runs';
import { runEvaluatorTurn, type RunEvaluatorTurn } from './evaluate-agent';
// `reworkBrief` is deliberately NOT called here — the brief is derived at dispatch time from the
// recorded findings (`brief.ts`), so the wording the Robot receives always matches the stored
// verdict rather than being a second copy that can drift.
import { MAX_DIFF_CHARS, MAX_EVALUATION_ROUNDS, MAX_UNPARSEABLE_CHARS, blockingFindings, parseEvaluatorReport } from './verdict';
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
  /** PD-793: the PR commenter for the "capture is off" / "no UI change" line. */
  comment?: Commenter;
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
  const select = { ticketId: target.ticketId, prNumber: target.prNumber, since };
  const priorStates = lensStates(db, select);

  // PD-883: only the lenses that still need review this pass — a lens that already decided this cycle
  // (shipped/escalated, revised to the round cap, or errored twice) is folded in from the DB below
  // instead of re-run. The revise round for a lens counts its prior VERDICT runs only, so an error
  // retry never consumes a legitimate revise round.
  const needed = lenses.filter((l) => lensNeedsRun(priorStates.get(l)));
  const roundFor = (l: EvaluatorLens) => (priorStates.get(l)?.verdictRuns ?? 0) + 1;
  const round = Math.max(1, ...needed.map(roundFor));

  // PD-763: the review-gate status, only when its token is configured. A status failure is logged by
  // the poster and never affects the evaluation.
  const gateOn = config.evaluator.reviewGateToken !== '';
  const postStatus = deps.postStatus ?? defaultStatusPoster(config);
  let gateSha: string | null = null;
  const gate = async (status: ReturnType<typeof gateForOutcome>) => {
    if (gateOn && gateSha) await postStatus(target.repo, gateSha, status, gateTargetUrl(config, displayIdFor(db, target.ticketId)));
  };

  // PD-883: start every lens's decision from what the cycle already holds. A lens we are NOT re-running
  // folds in its latest verdict (so a lens that already shipped is not read as a missing verdict); a
  // lens that errored out its retry folds in as null and keeps the PR from passing.
  const reports = new Map<EvaluatorLens, EvaluatorReport | null>();
  for (const l of lenses) {
    if (!needed.includes(l)) reports.set(l, latestLensReport(db, select, l));
  }

  // Nothing new to review — every enabled lens is already settled (runEvaluatePass's
  // `alreadyEvaluated` already skips this; this is the defensive direct-call path). Decide from the
  // folded verdicts alone, with no new runs, milestones or gate writes.
  if (needed.length === 0) {
    return combineReports(lenses.map((l) => reports.get(l) ?? null));
  }

  // Written BEFORE the pass, so an evaluation that dies or hangs is legible on the timeline as
  // "reviewing…" with no verdict after it. A failure writes no verdict on purpose (it must never
  // read as approval), which without this marker would make it invisible rather than merely
  // inconclusive.
  const runIds = new Map<EvaluatorLens, number>();
  for (const lens of needed) {
    runIds.set(
      lens,
      startEvaluatorRun(db, { ticketId: target.ticketId, prNumber: target.prNumber, round: roundFor(lens), model: config.evaluator.model, lens }, now),
    );
    logMilestone(db, target.ticketId, ROBOT_EVENT.evaluating, { round: roundFor(lens), prNumber: target.prNumber, lens }, now);
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

  // Each needed lens reviews independently. A lens with no usable verdict records its error and
  // yields null.
  for (const lens of needed) {
    const runId = runIds.get(lens)!;
    const r = roundFor(lens);
    const system = lens === 'security' ? securityEvaluatorSystemPrompt(contextPack) : evaluatorSystemPrompt(contextPack);
    const result = await runAgent(config, system, userPrompt, (t, k) => updateEvaluatorRunProgress(db, runId, t, k));
    if (!result.ok) {
      finishEvaluatorRun(db, runId, { error: result.text || 'agent error', turns: result.turns, tokens: result.tokens }, now);
      logger.warn({ ticketId: target.ticketId, lens, error: result.text }, 'evaluator: agent turn failed');
      reports.set(lens, null);
      continue;
    }
    const report = parseEvaluatorReport(result.text);
    if (!report) {
      // PD-883: keep the full reply (bounded), not a 500-char head — for an unparseable reply the
      // tail is usually where the malformed JSON or truncation is.
      finishEvaluatorRun(
        db,
        runId,
        { error: `unparseable report: ${result.text.slice(0, MAX_UNPARSEABLE_CHARS)}`, turns: result.turns, tokens: result.tokens },
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

  // One decision for the PR, from every lens (fresh this pass or folded from the cycle). Any missing
  // verdict means the PR cannot pass (D-076: a failed evaluation is never approval); otherwise the
  // worst verdict wins.
  const combined = combineReports(lenses.map((l) => reports.get(l) ?? null));

  // PD-773: the Evaluator may ask for Steve's visual check. Recorded once per PR; it never changes
  // the verdict, only what a ship does to review-gate below.
  const visualAsk = [...reports.values()].find((r) => r?.visualReview)?.visualReview;
  if (visualAsk && !visualRequested(db, target.ticketId, target.prNumber)) {
    logMilestone(db, target.ticketId, ROBOT_EVENT.visualReviewRequested, { prNumber: target.prNumber, by: 'evaluator', reason: visualAsk }, now);
  }
  // Only a lens that revised THIS pass drives rework — a folded revise was already acted on when it
  // was first recorded. The round that matters is the highest among them.
  const reviseRound = Math.max(0, ...needed.filter((l) => reports.get(l)?.verdict === 'revise').map(roundFor));

  if (combined?.verdict === 'revise' && reviseRound > 0) {
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

  // PD-883: when the combined decision is a no-verdict failure, name the lens behind it and whether
  // its one error retry is still pending or has been used, for both the gate description and the
  // terminal notification. Recompute states AFTER this pass's runs are recorded.
  const finalStates = lensStates(db, select);
  const erroredLenses = lenses.filter((l) => {
    const s = finalStates.get(l);
    return !!s && s.verdictRuns === 0 && s.errorRuns > 0;
  });
  const failureCtx = erroredLenses.length
    ? { lens: erroredLenses[0], retryUsed: (finalStates.get(erroredLenses[0])?.errorRuns ?? 0) >= MAX_LENS_ERROR_RUNS }
    : undefined;

  let status = gateForOutcome(combined, combined?.verdict === 'revise' ? reviseRound : round, MAX_EVALUATION_ROUNDS, failureCtx);
  // PD-773: a ship on a PR that waits for Steve's visual check holds the gate at pending. His approval
  // releases it (releaseVisualGates); until then he is told it is waiting.
  // PD-793: only while capture is on. With it off there is nothing to look at, so the gate skips
  // itself; the request stays on the ticket and the PR says the check was skipped (below).
  if (status.state === 'success' && config.visual.enabled) {
    const vg = visualGate(db, target.ticketId, target.prNumber, since);
    if (vg === 'pending' || vg === 'rejected') {
      status = { state: 'pending', description: VISUAL_PENDING_DESCRIPTION };
      const displayId = displayIdFor(db, target.ticketId);
      notify(
        db,
        'agent_visual_review',
        target.ticketId,
        `${VISUAL_REVIEW_NOTIFICATION_PREFIX} PR #${target.prNumber}${displayId ? ` (${displayId})` : ''}`,
        'The Evaluator shipped it, and it was flagged for your visual check. Approve or request changes in Decisions.',
        now,
      );
    }
  }
  await gate(status);

  // PD-883: when a lens has used its one retry (errored twice, no verdict) and the gate still fails,
  // surface it to a human — a PR that would otherwise sit silently in-review forever. notify's
  // (ticket, kind) unread dedup fires this once, not every poll.
  if (status.state === 'failure') {
    const exhausted = lenses.filter((l) => {
      const s = finalStates.get(l);
      return !!s && s.verdictRuns === 0 && s.errorRuns >= MAX_LENS_ERROR_RUNS;
    });
    if (exhausted.length > 0) {
      const displayId = displayIdFor(db, target.ticketId);
      notify(
        db,
        'agent_needs_human',
        target.ticketId,
        `Evaluator could not review PR #${target.prNumber}${displayId ? ` (${displayId})` : ''}`,
        `The ${exhausted.join(' and ')} review produced no usable verdict after its one retry. review-gate is failing; this PR needs a human review.`,
        now,
      );
    }
  }

  // PD-793: with capture off, the PR still says what happened with screenshots, once per head.
  if (!config.visual.enabled) {
    if (status.state === 'success') writeState(db, captureOffReleaseKey(target.ticketId), String(since), now);
    // No write token means no PR comment is possible; the dashboard still shows "capture off" from
    // the worker's heartbeat.
    const sha = config.robot.writeToken || deps.comment
      ? gateSha ?? (await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(target.repo, target.prNumber))
      : null;
    if (sha) {
      await recordCaptureOff(db, target, sha, {
        diff: rawDiff,
        requested: visualRequested(db, target.ticketId, target.prNumber),
        comment: deps.comment ?? defaultCommenter(config),
      }, now);
    }
  }
  return combined;
}

/** One decision from every lens: any missing verdict means no pass (D-076: a failed evaluation is
 *  never approval); otherwise the worst verdict wins. Shared with the all-PRs path (PD-712). */
export function combineReports(all: (EvaluatorReport | null)[]): EvaluatorReport | null {
  if (all.length === 0 || all.some((r) => r === null)) return null;
  const rs = all as EvaluatorReport[];
  return {
    verdict: rs.some((r) => r.verdict === 'escalate') ? 'escalate' : rs.some((r) => r.verdict === 'revise') ? 'revise' : 'ship',
    findings: rs.flatMap((r) => r.findings),
    summary: rs.map((r) => r.summary).join(' '),
  };
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

  // PD-773: act on Steve's visual decisions first. They cost no review budget, so a spent budget
  // must not leave an approved PR held or a rejected one un-reworked.
  try {
    const { releaseVisualDecisions } = await import('../visual/release');
    await releaseVisualDecisions(db, config, now, {
      boundary: reviewBoundary,
      fetchHeadSha: deps.fetchHeadSha,
      postStatus: deps.postStatus,
      comment: deps.comment,
    });
  } catch (err) {
    logger.error({ err }, 'evaluator: applying visual decisions threw — continuing');
  }

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

  // PD-883: idempotence is now per enabled lens — a PR is skipped only when every lens has settled
  // (a verdict or a used retry), so an errored lens is retried on a later poll.
  const enabledLenses: EvaluatorLens[] = config.evaluator.securityEnabled ? ['code', 'security'] : ['code'];
  let evaluated = 0;
  for (const target of inReviewPrTargets(db)) {
    const since = reviewBoundary(db, target.ticketId);
    if (alreadyEvaluated(db, target.ticketId, target.prNumber, since, enabledLenses)) continue;
    try {
      const report = await evaluateOnePr(db, config, target, deps, now);
      if (report) evaluated++;
    } catch (err) {
      // One bad PR must not strand the rest of the queue.
      logger.error({ err, ticketId: target.ticketId }, 'evaluator: evaluation threw — continuing');
    }
  }
  // PD-712 (D-101): then one non-Robot PR per pass, on the same budget and ledger.
  if (config.evaluator.allPrs) {
    try {
      const { evaluateNextOtherPr } = await import('./all-prs');
      const verdict = await evaluateNextOtherPr(db, config, now, deps);
      if (verdict) evaluated++;
    } catch (err) {
      logger.error({ err }, 'evaluator: non-Robot PR review threw — continuing');
    }
  }
  return evaluated;
}
