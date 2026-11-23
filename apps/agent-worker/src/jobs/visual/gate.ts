import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type RobotEventDetail } from '@dashboard/shared';

/**
 * The visual-review gate (PD-773 slice 2), read from the ticket's own events. Pure over the DB.
 *
 *  - **Requested** when the Robot (`.robot/visual-review`) or the Evaluator (`visualReview`) asked for
 *    Steve's visual check of a PR. It sticks to that PR: a rework or a conflict resolution of the same
 *    PR still needs his eyes.
 *  - **Decided** by his newest `robot_visual_reviewed` AFTER the current review boundary (the last
 *    hand-off or conflict resolution). An approval of an older head does not carry to a new one.
 *
 * While requested and not approved, an Evaluator ship holds `review-gate` at pending; the approval
 * releases it, and a rejection sends the PR back to the Robot with his note.
 */

export type VisualGate = 'not-requested' | 'pending' | 'approved' | 'rejected';

interface EventRow {
  id: number;
  detail: string | null;
  created_at: number;
}

const detail = (r: EventRow): RobotEventDetail => {
  try {
    return (JSON.parse(r.detail ?? '{}') as RobotEventDetail) ?? {};
  } catch {
    return {};
  }
};

export function visualRequested(db: Database.Database, ticketId: number, prNumber: number): boolean {
  const rows = db
    .prepare('SELECT id, detail, created_at FROM agent_ticket_events WHERE ticket_id = ? AND type = ?')
    .all(ticketId, ROBOT_EVENT.visualReviewRequested) as EventRow[];
  return rows.some((r) => detail(r).prNumber === prNumber);
}

/** Steve's newest visual decision after `boundary`, with its event id; null when there is none. */
export function latestVisualDecision(
  db: Database.Database,
  ticketId: number,
  boundary: number,
): { id: number; approved: boolean; note: string; createdAt: number } | null {
  const row = db
    .prepare(
      `SELECT id, detail, created_at FROM agent_ticket_events
        WHERE ticket_id = ? AND type = ? AND created_at > ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(ticketId, ROBOT_EVENT.visualReviewed, boundary) as EventRow | undefined;
  if (!row) return null;
  const d = detail(row);
  return { id: row.id, approved: d.approved === true, note: d.note ?? '', createdAt: row.created_at };
}

export function visualGate(db: Database.Database, ticketId: number, prNumber: number, boundary: number): VisualGate {
  if (!visualRequested(db, ticketId, prNumber)) return 'not-requested';
  const decision = latestVisualDecision(db, ticketId, boundary);
  if (!decision) return 'pending';
  return decision.approved ? 'approved' : 'rejected';
}

/**
 * The review boundary for a **session** PR's visual check (PD-915): when the Evaluator last started
 * reviewing that PR, i.e. its current head. A session PR has no hand-off to anchor on, and every new
 * head gets a new review, so "an approval of an older head does not carry" holds the same way.
 * 0 when it was never reviewed. The server mirrors this in `visual-review.ts`.
 */
export function sessionReviewBoundary(db: Database.Database, ticketId: number, prNumber: number): number {
  const rows = db
    .prepare('SELECT detail, created_at FROM agent_ticket_events WHERE ticket_id = ? AND type = ? ORDER BY created_at DESC, id DESC')
    .all(ticketId, ROBOT_EVENT.evaluating) as { detail: string | null; created_at: number }[];
  const hit = rows.find((r) => detail({ id: 0, ...r }).prNumber === prNumber);
  return hit?.created_at ?? 0;
}

/** The pending status description, kept under GitHub's 140-character cap. */
export const VISUAL_PENDING_DESCRIPTION = "Waiting for Steve's visual check (Evaluator: ship)";
