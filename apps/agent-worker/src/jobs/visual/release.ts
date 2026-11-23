import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { setAgentState } from '../robot/board';
import { logMilestone } from '../robot/events';
import { inReviewPrTargets } from '../robot/pr-state';
import { readStateNumber, writeState } from '../robot/state';
import { defaultHeadShaFetcher, defaultStatusPoster, type HeadShaFetcher, type StatusPoster } from '../evaluate/review-gate';
import { latestVisualDecision, sessionReviewBoundary, visualRequested } from './gate';
import { adoptedPrNumbers } from '../evaluate/adoption';
import { defaultCommenter } from './pass';
import { captureOffReleaseKey, recordCaptureOff, type Commenter } from './status';

/**
 * Act on Steve's visual decisions (PD-773 slice 2), once each:
 *  - **approved**: post the `review-gate` success the Evaluator's ship was holding, when every lens's
 *    newest verdict since the review boundary is `ship`. (No ship yet means the Evaluator's own pass
 *    will post success later, since the approval now stands.)
 *  - **rejected**: send the PR back to the Robot, with his note, which the next dispatch reads as part
 *    of its rework brief (`pendingEvaluatorBrief`).
 * "Once" is a robot_state key per ticket holding the decision's event id.
 *
 * PD-793: with capture off, a requested check with no decision is released the same way as an
 * approval, once per review boundary: nothing will ever be photographed, so holding it only strands
 * the PR. This unsticks PRs the gate held before it learned to skip itself.
 */

export interface ReleaseDeps {
  fetchHeadSha?: HeadShaFetcher;
  postStatus?: StatusPoster;
  /** The review boundary for a ticket (the Evaluator's `reviewBoundary`), injected to avoid a cycle. */
  boundary: (db: Database.Database, ticketId: number) => number;
  comment?: Commenter;
}

/** Whether every lens's newest verdict on this ticket's Robot PR since `since` is `ship`. */
export function lastVerdictsShip(db: Database.Database, ticketId: number, since: number, lenses: string[]): boolean {
  return lenses.every((lens) => {
    const row = db
      .prepare(
        `SELECT verdict FROM evaluator_runs
          WHERE ticket_id = ? AND lens = ? AND started_at >= ? AND head_sha IS NULL AND verdict IS NOT NULL
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(ticketId, lens, since) as { verdict: string } | undefined;
    return row?.verdict === 'ship';
  });
}

export async function releaseVisualDecisions(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number,
  deps: ReleaseDeps,
): Promise<number> {
  let acted = 0;
  const lenses = config.evaluator.securityEnabled ? ['code', 'security'] : ['code'];
  for (const t of inReviewPrTargets(db)) {
    if (!visualRequested(db, t.ticketId, t.prNumber)) continue;
    const since = deps.boundary(db, t.ticketId);
    const decision = latestVisualDecision(db, t.ticketId, since);
    if (!decision) {
      if (!config.visual.enabled && (await releaseCaptureOff(db, config, t, since, lenses, now, deps))) acted++;
      continue;
    }
    const key = `visual_decision_applied:${t.ticketId}`;
    if (readStateNumber(db, key) === decision.id) continue;

    if (!decision.approved) {
      setAgentState(db, t.ticketId, 'queued', now);
      logMilestone(db, t.ticketId, ROBOT_EVENT.reactivated, {
        reason: `Steve's visual check asked for changes${decision.note ? `: ${decision.note}` : ''}`.slice(0, 500),
        prNumber: t.prNumber,
      }, now);
      writeState(db, key, String(decision.id), now);
      acted++;
      continue;
    }
    if (!config.evaluator.reviewGateToken || !lastVerdictsShip(db, t.ticketId, since, lenses)) continue;
    const sha = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(t.repo, t.prNumber);
    if (!sha) continue;
    const ok = await (deps.postStatus ?? defaultStatusPoster(config))(
      t.repo,
      sha,
      { state: 'success', description: "Evaluator: ship; Steve's visual check: approved" },
      null,
    );
    if (ok) {
      writeState(db, key, String(decision.id), now);
      logger.info({ ticketId: t.ticketId, prNumber: t.prNumber }, 'visual: approved — review-gate released');
      acted++;
    }
  }
  acted += await releaseSessionVisualDecisions(db, config, now, deps, lenses);
  return acted;
}

/**
 * The same, for session PRs (PD-915). The boundary is the start of the PR's latest review
 * (`sessionReviewBoundary`), since a session PR has no hand-off.
 *  - **approved**: post success on the reviewed head, when every lens shipped it and it is still the
 *    head (a newer head gets its own review and its own check).
 *  - **rejected**: nothing to dispatch here. The adoption pass reads the rejection as a revise and
 *    hands the PR to the Robot after the idle window (PD-913), with his note in the brief.
 */
async function releaseSessionVisualDecisions(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number,
  deps: ReleaseDeps,
  lenses: string[],
): Promise<number> {
  const robotOwned = new Set([...inReviewPrTargets(db).map((t) => t.prNumber), ...adoptedPrNumbers(db)]);
  const requests = db
    .prepare(
      `SELECT DISTINCT e.ticket_id AS ticketId, json_extract(e.detail, '$.prNumber') AS prNumber
         FROM agent_ticket_events e
         JOIN agent_tickets t ON t.id = e.ticket_id
        WHERE e.type = ? AND t.archived_at IS NULL AND t.status NOT IN ('completed', 'closed')`,
    )
    .all(ROBOT_EVENT.visualReviewRequested) as { ticketId: number; prNumber: number | null }[];
  let acted = 0;
  for (const { ticketId, prNumber } of requests) {
    if (prNumber === null || robotOwned.has(prNumber)) continue;
    const since = sessionReviewBoundary(db, ticketId, prNumber);
    if (since === 0) continue;
    const decision = latestVisualDecision(db, ticketId, since);
    if (!decision) continue;
    const key = `visual_decision_applied:${ticketId}`;
    if (readStateNumber(db, key) === decision.id) continue;
    if (!decision.approved) {
      writeState(db, key, String(decision.id), now);
      acted++;
      continue;
    }
    const reviewed = sessionHeadShipped(db, prNumber, since, lenses);
    if (!reviewed || !config.evaluator.reviewGateToken) continue;
    const sha = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(config.githubRepo, prNumber);
    if (sha !== reviewed) continue;
    const ok = await (deps.postStatus ?? defaultStatusPoster(config))(
      config.githubRepo,
      sha,
      { state: 'success', description: "Evaluator: ship; Steve's visual check: approved" },
      null,
    );
    if (ok) {
      writeState(db, key, String(decision.id), now);
      logger.info({ ticketId, prNumber }, 'visual: approved on a session PR — review-gate released');
      acted++;
    }
  }
  return acted;
}

/** The head every lens of a session PR's review since `since` shipped, or null. */
export function sessionHeadShipped(db: Database.Database, prNumber: number, since: number, lenses: string[]): string | null {
  const rows = db
    .prepare(
      `SELECT lens, verdict, head_sha FROM evaluator_runs
        WHERE pr_number = ? AND head_sha IS NOT NULL AND started_at >= ?
        ORDER BY started_at DESC, id DESC`,
    )
    .all(prNumber, since) as { lens: string; verdict: string | null; head_sha: string }[];
  const head = rows[0]?.head_sha;
  if (!head) return null;
  const ok = lenses.every((lens) => rows.find((r) => r.lens === lens && r.head_sha === head)?.verdict === 'ship');
  return ok ? head : null;
}

/** Release a held ship whose visual check can't happen because capture is off (PD-793). */
async function releaseCaptureOff(
  db: Database.Database,
  config: AgentWorkerConfig,
  t: { ticketId: number; repo: string; prNumber: number },
  since: number,
  lenses: string[],
  now: number,
  deps: ReleaseDeps,
): Promise<boolean> {
  const key = captureOffReleaseKey(t.ticketId);
  if (readStateNumber(db, key) === since) return false;
  if (!config.evaluator.reviewGateToken || !lastVerdictsShip(db, t.ticketId, since, lenses)) return false;
  const sha = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(t.repo, t.prNumber);
  if (!sha) return false;
  const ok = await (deps.postStatus ?? defaultStatusPoster(config))(
    t.repo,
    sha,
    { state: 'success', description: 'Evaluator: ship; visual check skipped (capture is off)' },
    null,
  );
  if (!ok) return false;
  writeState(db, key, String(since), now);
  if (config.robot.writeToken || deps.comment) {
    await recordCaptureOff(db, t, sha, { diff: null, requested: true, comment: deps.comment ?? defaultCommenter(config) }, now);
  }
  logger.info({ ticketId: t.ticketId, prNumber: t.prNumber }, 'visual: capture is off — held review-gate released');
  return true;
}
