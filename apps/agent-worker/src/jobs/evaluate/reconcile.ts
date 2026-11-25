import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type EvaluatorLens } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { logMilestone } from '../robot/events';
import { inReviewPrTargets } from '../robot/pr-state';
import { displayIdFor, reviewBoundary, settledGate, type EvaluatePassDeps } from './evaluate';
import { alreadyEvaluated, cycleReviewedHeads } from './evaluator-runs';
import {
  defaultHeadShaFetcher,
  defaultStatusPoster,
  defaultStatusReader,
  gateTargetUrl,
  isReviewingStatus,
  isSteveApproval,
} from './review-gate';

/**
 * The review-gate reconciliation (PD-1005, Reconcile a lost review-gate post).
 *
 * `defaultStatusPoster` swallows failures, and once every lens has settled `alreadyEvaluated` skips
 * the PR for good. So a lost final post (a GitHub blip, a worker restart between the verdict and the
 * post) left the head on `pending · Evaluator reviewing` forever: PR #576 sat BLOCKED with two `ship`
 * verdicts in the DB. This pass is the safety net for every such failure mode. It spends no agent
 * turns, so `runEvaluatePass` runs it before the budget gate.
 *
 * For each in-review Robot PR whose review cycle is settled:
 *  - **the head moved after the verdict** (the runs name an older commit): log
 *    `robot_review_head_moved`, which opens a fresh review cycle (`reviewBoundary`), so the review
 *    loop reviews the new head. The old verdict is never copied onto a commit nobody reviewed.
 *  - **the head is the reviewed one** and its `review-gate` is missing or is the stale "Evaluator
 *    reviewing" pending: post the gate the stored verdicts imply (`settledGate`, the same table and
 *    visual hold `evaluateOnePr` uses).
 *  - anything else on the head (a verdict status, a visual hold, Steve's approval) is left alone. In
 *    particular it never replaces `Approved by Steve` (PD-914, Evaluator never replaces Steve's
 *    approval), and since it only ever writes over a missing or pending status, it never writes over
 *    a success at all. A failed status read posts nothing.
 *
 * Runs from before Robot runs recorded `head_sha` (or whose head pin failed) name no commit. For those
 * the "Evaluator reviewing" pending on the head is the evidence that the review pinned this commit,
 * so the verdict is reposted there; with no status at all nothing ties the verdict to this head, and
 * it is reviewed again instead.
 *
 * With `REVIEW_GATE_TOKEN` unset there is no gate to reconcile, and the pass does nothing.
 */
export async function reconcileReviewGates(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number,
  deps: EvaluatePassDeps = {},
): Promise<number> {
  if (!config.evaluator.reviewGateToken) return 0;
  const lenses: EvaluatorLens[] = config.evaluator.securityEnabled ? ['code', 'security'] : ['code'];
  let acted = 0;
  for (const target of inReviewPrTargets(db)) {
    try {
      if (await reconcileOne(db, config, target, lenses, now, deps)) acted++;
    } catch (err) {
      // One bad PR must not stop the rest being reconciled.
      logger.error({ err, ticketId: target.ticketId, prNumber: target.prNumber }, 'evaluator: review-gate reconciliation failed for a PR — continuing');
    }
  }
  return acted;
}

async function reconcileOne(
  db: Database.Database,
  config: AgentWorkerConfig,
  target: { ticketId: number; repo: string; prNumber: number },
  lenses: EvaluatorLens[],
  now: number,
  deps: EvaluatePassDeps,
): Promise<boolean> {
  const since = reviewBoundary(db, target.ticketId);
  // A cycle still owing a run is the review loop's job; it posts its own gate.
  if (!alreadyEvaluated(db, target.ticketId, target.prNumber, since, lenses, config.evaluator.maxRounds)) return false;

  const head = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(target.repo, target.prNumber);
  if (!head) return false;

  const reviewed = cycleReviewedHeads(db, { ticketId: target.ticketId, prNumber: target.prNumber, since }, lenses);
  const stale = reviewed.find((h) => h !== null && h !== head);
  if (stale) {
    headMoved(db, target, `the Evaluator reviewed ${stale.slice(0, 7)}, the head is now ${head.slice(0, 7)}`, now);
    return true;
  }

  const read = await (deps.readStatus ?? defaultStatusReader(config))(target.repo, head);
  if (!read.ok) return false;
  const current = read.current;
  if (isSteveApproval(current)) return false;
  if (current !== null && !isReviewingStatus(current)) return false;

  const headKnown = reviewed.every((h) => h !== null);
  if (!headKnown && current === null) {
    headMoved(db, target, `no record of which commit the verdict was for, and ${head.slice(0, 7)} has no review-gate status`, now);
    return true;
  }

  const status = settledGate(db, config, target, since, lenses);
  const posted = await (deps.postStatus ?? defaultStatusPoster(config))(
    target.repo,
    head,
    status,
    gateTargetUrl(config, displayIdFor(db, target.ticketId)),
  );
  logger.info(
    {
      ticketId: target.ticketId,
      prNumber: target.prNumber,
      sha: head,
      state: status.state,
      description: status.description,
      reason: current === null ? 'no review-gate status on the head' : 'stale "Evaluator reviewing" status',
      posted,
    },
    posted ? 'evaluator: review-gate reconciled' : 'evaluator: review-gate reconciliation post failed — retrying next pass',
  );
  return posted;
}

/** Open a fresh review cycle for a head the settled verdict does not cover. */
function headMoved(
  db: Database.Database,
  target: { ticketId: number; prNumber: number },
  reason: string,
  now: number,
): void {
  logMilestone(db, target.ticketId, ROBOT_EVENT.reviewHeadMoved, { prNumber: target.prNumber, reason }, now);
  logger.info(
    { ticketId: target.ticketId, prNumber: target.prNumber, reason },
    'evaluator: review-gate reconciliation — the head is not the reviewed one, reviewing it again',
  );
}
