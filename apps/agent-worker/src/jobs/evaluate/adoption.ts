import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import { logger } from '../../shared/logger';
import { latestEvent, latestEventAt, logMilestone } from '../robot/events';
import { notify } from '../robot/notify';

/**
 * The Robot takes over an idle session PR the Evaluator sent back (PD-913, D-111).
 *
 * A session PR (opened by Steve, not on a `robot/*` branch) that the Evaluator revised gets no rework
 * on its own: the PR comment just waits for a push. Once it has gone `adoptIdleMs` without one, the
 * Robot adopts it. The PR's **branch ticket** is handed to the Robot (`assignee = 'robot'`, queued),
 * and from there it is an ordinary Robot rework: the dispatch picks it up, the Evaluator's findings
 * are its brief (`pendingEvaluatorBrief`), and its push updates the same PR on Steve's branch. After
 * hand-off it is an in-review Robot target like any other: Robot-path reviews, statuses, needs-human
 * and complete-on-merge.
 *
 * These are the rules and the DB writes; the pass that applies them is `adopt-pass.ts`.
 *
 * Every read degrades to "not adoptable" rather than throwing. The callers include the review path,
 * and a missing table in a partial deployment must not stop a PR being reviewed.
 */

/** The ticket display id a session branch names (`pd-913-adopt` → `PD-913`), or null. */
export function branchDisplayId(headRefName: string): string | null {
  const m = /^([a-z]{1,4})-(\d+)(?:-|$)/i.exec(headRefName);
  return m ? `${m[1]}-${m[2]}`.toUpperCase() : null;
}

export interface AdoptableTicket {
  id: number;
  displayId: string;
  title: string;
}

/**
 * The branch's ticket when the Robot could take it over, else null. The ticket must pass the same
 * gates a queued Robot ticket does (refined, ready, robot-enabled project, not blocked): adoption is a
 * hand-off into the normal dispatch, and a ticket the dispatch would never pick up would just strand.
 * Never a terminal ticket (D-083), and never one the Robot already holds in any state.
 */
export function adoptableTicket(db: Database.Database, headRefName: string): AdoptableTicket | null {
  if (headRefName.startsWith('robot/')) return null;
  const displayId = branchDisplayId(headRefName);
  if (!displayId) return null;
  try {
    const row = db
      .prepare(
        `SELECT t.id AS id, t.display_id AS displayId, t.title AS title
           FROM agent_tickets t
           JOIN agent_projects p ON p.id = t.project_id
          WHERE t.display_id = ?
            AND t.archived_at IS NULL
            AND t.status NOT IN ('completed', 'closed')
            AND NOT (t.assignee = 'robot' AND t.agent_state IS NOT NULL)
            AND t.refined = 1
            AND (t.ready = 1 OR t.ready_bypassed = 1)
            AND p.robot_enabled = 1
            AND p.github_repo IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM agent_ticket_relations r
                JOIN agent_tickets blocker ON blocker.id = r.from_ticket_id
               WHERE r.type = 'blocks'
                 AND r.to_ticket_id = t.id
                 AND blocker.archived_at IS NULL
                 AND blocker.status NOT IN ('completed', 'closed')
            )`,
      )
      .get(displayId) as AdoptableTicket | undefined;
    return row ?? null;
  } catch (err) {
    logger.warn({ err, headRefName }, 'adoption: ticket lookup failed (treating as not adoptable)');
    return null;
  }
}

export interface HeadVerdict {
  verdict: 'ship' | 'revise' | 'escalate' | 'none';
  round: number;
  finishedAt: number;
}

/**
 * The combined verdict of every lens's review of one PR head, or null while any is still running or
 * none exists. A lens that errored makes it `none`, which is never adopted.
 */
export function headVerdict(db: Database.Database, prNumber: number, headSha: string): HeadVerdict | null {
  let rows: { verdict: string | null; round: number; finished_at: number | null }[];
  try {
    rows = db
      .prepare('SELECT verdict, round, finished_at FROM evaluator_runs WHERE pr_number = ? AND head_sha = ?')
      .all(prNumber, headSha) as typeof rows;
  } catch {
    return null;
  }
  if (rows.length === 0 || rows.some((r) => r.finished_at === null)) return null;
  const verdicts = rows.map((r) => r.verdict);
  const verdict: HeadVerdict['verdict'] = verdicts.some((v) => v === null)
    ? 'none'
    : verdicts.includes('escalate')
      ? 'escalate'
      : verdicts.includes('revise')
        ? 'revise'
        : 'ship';
  return {
    verdict,
    round: Math.max(...rows.map((r) => r.round)),
    finishedAt: Math.max(...rows.map((r) => r.finished_at ?? 0)),
  };
}

/**
 * The PR a ticket was adopted from, while that adoption stands (it has not been released since).
 * The dispatch uses its branch instead of `robot/t<id>`, so the rework lands on Steve's PR.
 */
export function adoptedFrom(db: Database.Database, ticketId: number): { prNumber: number; branch: string } | null {
  const ev = latestEvent(db, ticketId, ROBOT_EVENT.adopted);
  if (!ev?.detail.branch || ev.detail.prNumber === undefined) return null;
  if (latestEventAt(db, ticketId, ROBOT_EVENT.released) >= ev.createdAt) return null;
  return { prNumber: ev.detail.prNumber, branch: ev.detail.branch };
}

/** An adoption the dispatch has not started yet: still queued, no dispatch since it was taken. */
export interface PendingAdoption {
  ticketId: number;
  prNumber: number;
  headSha: string;
}

export function pendingAdoptions(db: Database.Database): PendingAdoption[] {
  let ids: { id: number }[];
  try {
    ids = db
      .prepare(
        `SELECT id FROM agent_tickets
          WHERE archived_at IS NULL AND status = 'queue' AND assignee = 'robot' AND agent_state = 'queued'`,
      )
      .all() as { id: number }[];
  } catch {
    return [];
  }
  const out: PendingAdoption[] = [];
  for (const { id } of ids) {
    const ev = latestEvent(db, id, ROBOT_EVENT.adopted);
    if (!ev?.detail.headSha || ev.detail.prNumber === undefined) continue;
    if (latestEventAt(db, id, ROBOT_EVENT.released) >= ev.createdAt) continue;
    if (latestEventAt(db, id, ROBOT_EVENT.dispatched) >= ev.createdAt) continue;
    out.push({ ticketId: id, prNumber: ev.detail.prNumber, headSha: ev.detail.headSha });
  }
  return out;
}

/**
 * PR numbers of adoptions the Robot holds but has not handed off yet (queued or working). The review
 * path skips them: a push by the Robot mid-rework is not a session push to review. Once handed off
 * they are in-review Robot targets, which it already skips.
 */
export function adoptedPrNumbers(db: Database.Database): Set<number> {
  let ids: { id: number }[];
  try {
    ids = db
      .prepare(
        `SELECT id FROM agent_tickets
          WHERE archived_at IS NULL AND status = 'queue' AND assignee = 'robot' AND agent_state IN ('queued', 'working')`,
      )
      .all() as { id: number }[];
  } catch {
    return new Set();
  }
  const out = new Set<number>();
  for (const { id } of ids) {
    const a = adoptedFrom(db, id);
    if (a) out.add(a.prNumber);
  }
  return out;
}

/** Hand the ticket to the Robot for rework on the PR's own branch. */
export function adoptTicket(
  db: Database.Database,
  ticketId: number,
  pr: { number: number; headRefName: string; headRefOid: string },
  now: number,
): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE agent_tickets SET assignee = 'robot', status = 'queue', agent_state = 'queued', updated_at = ? WHERE id = ?",
    ).run(now, ticketId);
    logMilestone(db, ticketId, ROBOT_EVENT.adopted, { prNumber: pr.number, branch: pr.headRefName, headSha: pr.headRefOid }, now);
    // A rework of this PR, in the form PD-924 (dispatch guard) and PD-926 (in-flight supersede) look
    // for: they then complete it if the PR merges, stop on a close, and stop mid-run if Steve pushes.
    // The reason deliberately does not start "evaluator requested changes", so PD-924 never sends an
    // adopted ticket "back to in-review" (it has no Robot hand-off to be in review on).
    logMilestone(db, ticketId, ROBOT_EVENT.reactivated, { reason: 'adopted: the Evaluator asked for changes on a session PR', prNumber: pr.number }, now);
  })();
}

/** Give an adoption back to Steve before the Robot started on it, and tell him why. */
export function releaseAdoption(
  db: Database.Database,
  ticketId: number,
  prNumber: number,
  reason: string,
  now: number,
): void {
  db.transaction(() => {
    db.prepare("UPDATE agent_tickets SET assignee = 'steve', agent_state = NULL, updated_at = ? WHERE id = ?").run(now, ticketId);
    logMilestone(db, ticketId, ROBOT_EVENT.released, { prNumber, reason }, now);
  })();
  notify(db, 'agent_needs_human', ticketId, `PR #${prNumber} is back with you`, `The Robot did not start the rework: ${reason}.`, now);
}
