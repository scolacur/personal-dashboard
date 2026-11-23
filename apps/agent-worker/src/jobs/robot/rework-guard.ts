import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type RobotEventDetail } from '@dashboard/shared';
import type { PrFetcher } from './pr-state';

/**
 * Pre-dispatch rework guard (PD-924).
 *
 * A rework is queued when something asks for changes on a ticket's open PR — an Evaluator `revise`,
 * a review or comment, a conflict (`robot_reactivated`). It can then sit queued for a long time: the
 * loop may be paused, holding, or at capacity. By the time it dispatches, the PR may have moved on.
 * On 2026-11-23 PD-761's rework dispatched 78 minutes after the Evaluator's `revise`, when the loop
 * was resumed from a circuit-breaker pause. In between, a human had rebased the PR and fixed both
 * blocking findings, and the PR merged four minutes into the run. The Robot spent a full run
 * redoing merged work.
 *
 * So, immediately before dispatching a rework, look at the PR once:
 *  - MERGED → the ticket is done. Complete it; don't dispatch.
 *  - CLOSED (unmerged) → the PR was abandoned. Park for a human; don't dispatch.
 *  - OPEN, and the ONLY ask is an Evaluator revise of a commit that is no longer the PR's head →
 *    someone else changed the PR since the review. The findings describe code that may not exist any
 *    more. Send it back to in-review so the Evaluator reviews what is actually there.
 *  - anything else → dispatch as usual.
 *
 * Fails open: if GitHub can't be reached, dispatch. A missed guard costs one run; a guard that blocks
 * on a GitHub hiccup would stall the whole Queue.
 *
 * Applies only to a REWORK — a `robot_reactivated` naming a PR since the last dispatch. A ticket that
 * was reopened by hand also has an old merged PR, and must not be auto-completed off it.
 */
export type ReworkGuardDecision =
  | { action: 'dispatch' }
  | { action: 'complete'; prNumber: number }
  | { action: 'park'; prNumber: number; reason: string }
  | { action: 'back-to-review'; prNumber: number; reason: string };

/** The `reason` prefix the Evaluator writes on its `robot_reactivated` (evaluate.ts). */
const EVALUATOR_REASON = /^evaluator requested changes/;

function lastDispatchAt(db: Database.Database, ticketId: number): number {
  try {
    const row = db
      .prepare('SELECT MAX(created_at) AS t FROM agent_ticket_events WHERE ticket_id = ? AND type = ?')
      .get(ticketId, ROBOT_EVENT.dispatched) as { t: number | null } | undefined;
    return row?.t ?? 0;
  } catch {
    return 0;
  }
}

/** Every reactivation since the last dispatch, oldest first — what this dispatch is a rework OF. */
function pendingReactivations(db: Database.Database, ticketId: number, since: number): RobotEventDetail[] {
  try {
    const rows = db
      .prepare(
        `SELECT detail FROM agent_ticket_events
          WHERE ticket_id = ? AND type = ? AND created_at > ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(ticketId, ROBOT_EVENT.reactivated, since) as { detail: string | null }[];
    return rows.map((r) => {
      try {
        return r.detail ? (JSON.parse(r.detail) as RobotEventDetail) : {};
      } catch {
        return {};
      }
    });
  } catch {
    return [];
  }
}

/** Head commits the pending Evaluator revises were made against. Null when a row didn't record one. */
function reviseHeads(db: Database.Database, ticketId: number, since: number): (string | null)[] {
  try {
    const rows = db
      .prepare(`SELECT head_sha FROM evaluator_runs WHERE ticket_id = ? AND verdict = 'revise' AND started_at > ?`)
      .all(ticketId, since) as { head_sha: string | null }[];
    return rows.map((r) => r.head_sha);
  } catch {
    return [];
  }
}

export async function checkRework(
  db: Database.Database,
  ticketId: number,
  repo: string,
  fetchPr: PrFetcher,
  /** True when a human answered an ask_human since the last dispatch — that answer needs a run
   *  whatever happened to the PR's head. */
  humanAnswered: boolean,
): Promise<ReworkGuardDecision> {
  const since = lastDispatchAt(db, ticketId);
  const reactivations = pendingReactivations(db, ticketId, since);
  const prNumber = [...reactivations].reverse().find((r) => typeof r.prNumber === 'number')?.prNumber;
  if (prNumber === undefined) return { action: 'dispatch' };

  const pr = await fetchPr(repo, prNumber);
  if (!pr) return { action: 'dispatch' };

  if (pr.state === 'MERGED') return { action: 'complete', prNumber };
  if (pr.state === 'CLOSED') {
    return { action: 'park', prNumber, reason: `PR #${prNumber} was closed without merging before the rework ran` };
  }

  const evaluatorOnly = reactivations.every((r) => EVALUATOR_REASON.test(r.reason ?? ''));
  if (!evaluatorOnly || humanAnswered || !pr.headRefOid) return { action: 'dispatch' };
  const heads = reviseHeads(db, ticketId, since);
  // Only when every revise names its commit and none is the current head. An unrecorded head proves
  // nothing, so it dispatches.
  if (heads.length === 0 || heads.some((h) => h === null || pr.headRefOid!.startsWith(h) || h.startsWith(pr.headRefOid!))) {
    return { action: 'dispatch' };
  }
  return {
    action: 'back-to-review',
    prNumber,
    reason: `PR #${prNumber} changed since the Evaluator's review (reviewed ${heads[heads.length - 1]!.slice(0, 7)}, now ${pr.headRefOid.slice(0, 7)}) — re-reviewing instead of reworking stale findings`,
  };
}
