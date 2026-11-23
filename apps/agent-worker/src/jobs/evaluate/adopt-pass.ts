import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { inReviewPrTargets } from '../robot/pr-state';
import {
  adoptableTicket,
  adoptedPrNumbers,
  adoptTicket,
  headVerdict,
  pendingAdoptions,
  releaseAdoption,
} from './adoption';
import { latestVisualDecision, sessionReviewBoundary } from '../visual/gate';
import { defaultOtherPrLister, defaultPrCommenter, skipReason, type OtherPrLister, type PrCommenter } from './all-prs';

export interface AdoptionPassDeps {
  listPrs?: OtherPrLister;
  comment?: PrCommenter;
}

/**
 * One adoption pass (PD-913, D-111), run by the Evaluator job before it reviews.
 *
 *  1. **Release** an adoption the Robot has not started when its PR moved under it (Steve pushed) or
 *     is no longer open. Once the Robot has started, the branch is its until hand-off; a push then
 *     is caught by the prompt, which parks rather than merging over his work.
 *  2. **Adopt** each session PR whose current head the Evaluator revised below the round cap, whose
 *     branch names an adoptable ticket, and that has had no push for `adoptIdleMs` since that review
 *     finished. A push restarts the clock, because it is a new head with a new review.
 */
export async function runAdoptionPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: AdoptionPassDeps = {},
): Promise<{ adopted: number; released: number }> {
  const result = { adopted: 0, released: 0 };
  if (!config.evaluator.adopt) return result;
  const prs = await (deps.listPrs ?? defaultOtherPrLister(config))(config.githubRepo);
  if (!prs) return result;
  const open = new Map(prs.map((p) => [p.number, p]));

  for (const a of pendingAdoptions(db)) {
    const pr = open.get(a.prNumber);
    const reason = !pr
      ? 'the PR is no longer open'
      : pr.headRefOid !== a.headSha
        ? 'you pushed to it before the Robot started'
        : null;
    if (!reason) continue;
    releaseAdoption(db, a.ticketId, a.prNumber, reason, now);
    logger.info({ ticketId: a.ticketId, prNumber: a.prNumber, reason }, 'adoption: released back to Steve');
    result.released++;
  }

  const owned = new Set([...inReviewPrTargets(db).map((t) => t.prNumber), ...adoptedPrNumbers(db)]);
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (owned.has(pr.number) || skipReason(pr, owned) !== null) continue;
    const ticket = adoptableTicket(db, pr.headRefName);
    if (!ticket) continue;
    const v = headVerdict(db, pr.number, pr.headRefOid);
    if (!v) continue;
    // PD-915: Steve rejecting the visual check of a shipped head counts as a revise, and the idle
    // clock runs from his decision. His note reaches the Robot through `pendingEvaluatorBrief`.
    const decision = latestVisualDecision(db, ticket.id, sessionReviewBoundary(db, ticket.id, pr.number));
    const visualRejected = v.verdict === 'ship' && decision !== null && !decision.approved;
    const revised = v.verdict === 'revise' && v.round < config.evaluator.maxRounds;
    if (!revised && !visualRejected) continue;
    const since = visualRejected ? Math.max(v.finishedAt, decision!.createdAt) : v.finishedAt;
    if (now - since < config.evaluator.adoptIdleMs) continue;

    adoptTicket(db, ticket.id, pr, now);
    result.adopted++;
    logger.info({ ticketId: ticket.id, prNumber: pr.number, branch: pr.headRefName }, 'adoption: Robot took over a session PR');
    const idleMin = Math.round(config.evaluator.adoptIdleMs / 60_000);
    await (deps.comment ?? defaultPrCommenter(config))(
      config.githubRepo,
      pr.number,
      [
        '<!-- robot:adopted -->',
        `**The Robot is taking over the rework** for ${ticket.displayId} (${ticket.title}).`,
        '',
        visualRejected
          ? `Steve's visual check asked for changes and this branch has had no push for ${idleMin} minutes.`
          : `The Evaluator asked for changes (round ${v.round}) and this branch has had no push for ${idleMin} minutes.`,
        'It will push fixes on top of your commits, never force-push, and the Evaluator reviews the result.',
        'Push to this branch before it starts and it comes straight back to you.',
      ].join('\n'),
    );
  }
  return result;
}
