import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { buildEvaluatorPrompt, evaluatorSystemPrompt, ROBOT_EVENT, type EvaluatorReport } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { buildContextPack } from '../../shared/context-pack';
import { logMilestone } from '../robot/events';
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

const run = promisify(execFile);

/**
 * The Evaluator pass (PD-487, [[D-076]]): review each in-review Robot PR against its ticket, record
 * the verdict on the ticket timeline, and send a `revise` back through the loop's existing rework
 * path.
 *
 * **It is a reviewer, not a gate.** Nothing here blocks a merge, and that is deliberate — the
 * path-guard is the gate, and a second merge blocker with no track record is how a loop deadlocks
 * (PD-487's own out-of-scope). A human still reviews and merges every PR.
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

  const since = lastHandoffAt(db, target.ticketId);
  const round = evaluationRounds(db, target.ticketId, since) + 1;
  const runId = startEvaluatorRun(
    db,
    { ticketId: target.ticketId, prNumber: target.prNumber, round, model: config.evaluator.model },
    now,
  );
  // Written BEFORE the pass, so an evaluation that dies or hangs is legible on the timeline as
  // "reviewing…" with no verdict after it. A failure writes no verdict on purpose (it must never
  // read as approval), which without this marker would make it invisible rather than merely
  // inconclusive.
  logMilestone(db, target.ticketId, ROBOT_EVENT.evaluating, { round, prNumber: target.prNumber }, now);

  const rawDiff = await fetchDiff(target.repo, target.prNumber);
  if (rawDiff === null) {
    finishEvaluatorRun(db, runId, { error: 'diff fetch failed' }, now);
    return null;
  }
  const { diff, truncated } = capDiff(rawDiff);

  const result = await runAgent(
    config,
    evaluatorSystemPrompt(
      buildContext(config.checkoutDir, (what) =>
        logger.warn({ what, ticketId: target.ticketId }, 'evaluator: context source missing — the review is degraded'),
      ),
    ),
    buildEvaluatorPrompt({
      title: ticket.title,
      body: ticket.body,
      prNumber: target.prNumber,
      diff,
      diffTruncated: truncated,
    }),
  );

  if (!result.ok) {
    finishEvaluatorRun(db, runId, { error: result.text || 'agent error', turns: result.turns, tokens: result.tokens }, now);
    logger.warn({ ticketId: target.ticketId, error: result.text }, 'evaluator: agent turn failed');
    return null;
  }

  const report = parseEvaluatorReport(result.text);
  if (!report) {
    finishEvaluatorRun(
      db,
      runId,
      { error: `unparseable report: ${result.text.slice(0, 500)}`, turns: result.turns, tokens: result.tokens },
      now,
    );
    logger.warn({ ticketId: target.ticketId }, 'evaluator: reply had no usable verdict — leaving the PR alone');
    return null;
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
      round,
      prNumber: target.prNumber,
      reason: report.summary,
    },
    now,
  );

  if (report.verdict === 'revise') {
    if (round >= MAX_EVALUATION_ROUNDS) {
      // The cap is the loop-safety limit (see MAX_EVALUATION_ROUNDS). At the ceiling the finding is
      // recorded and the human decides — sending it back again is the unbounded cycle.
      logger.warn(
        { ticketId: target.ticketId, round },
        'evaluator: revise at the round cap — leaving for the human instead of another rework',
      );
    } else {
      setAgentState(db, target.ticketId, 'queued', now);
      logMilestone(
        db,
        target.ticketId,
        ROBOT_EVENT.reactivated,
        { reason: `evaluator requested changes (round ${round})`, prNumber: target.prNumber },
        now,
      );
      logger.info({ ticketId: target.ticketId, blocking: blocking.length }, 'evaluator: revise → re-queued for rework');
    }
  } else {
    logger.info({ ticketId: target.ticketId, verdict: report.verdict }, 'evaluator: verdict recorded');
  }

  return report;
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
    const since = lastHandoffAt(db, target.ticketId);
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
