import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type AwaitingVisualItem, type RobotEventDetail } from '@dashboard/shared';

/**
 * Steve's side of the visual-review gate (PD-773 slice 2): which Robot PRs are waiting for his
 * visual check, and recording his answer.
 *
 * The rule mirrors the worker's (`apps/agent-worker/src/jobs/visual/gate.ts`): a request sticks to
 * its PR, and only a decision AFTER the current review boundary (the last hand-off or conflict
 * resolution) counts. The worker reads the decision event; nothing here touches GitHub.
 */

interface Ev {
  id: number;
  ticket_id: number;
  type: string;
  detail: string | null;
  created_at: number;
}

const parse = (e: Ev): RobotEventDetail => {
  try {
    return (JSON.parse(e.detail ?? '{}') as RobotEventDetail) ?? {};
  } catch {
    return {};
  }
};

const prFromUrl = (url: string | undefined): number | null => {
  const m = /\/pull\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
};

interface TicketRow {
  id: number;
  display_id: string | null;
  title: string;
}

/** The pending visual check for one in-review ticket, or null. */
function pendingFor(db: Database.Database, t: TicketRow): AwaitingVisualItem | null {
  const events = db
    .prepare(
      `SELECT id, ticket_id, type, detail, created_at FROM agent_ticket_events
        WHERE ticket_id = ? AND type IN (?, ?, ?, ?, ?) ORDER BY created_at, id`,
    )
    .all(
      t.id,
      ROBOT_EVENT.handoff,
      ROBOT_EVENT.conflictResolved,
      ROBOT_EVENT.visualReviewRequested,
      ROBOT_EVENT.visualReviewed,
      ROBOT_EVENT.visualCaptured,
    ) as Ev[];
  const handoffs = events.filter((e) => e.type === ROBOT_EVENT.handoff);
  const last = handoffs[handoffs.length - 1];
  if (!last) return null;
  const prUrl = parse(last).prUrl ?? null;
  const prNumber = prFromUrl(prUrl ?? undefined);
  if (prNumber === null) return null;
  const requests = events.filter((e) => e.type === ROBOT_EVENT.visualReviewRequested && parse(e).prNumber === prNumber);
  if (requests.length === 0) return null;
  const boundary = Math.max(
    last.created_at,
    ...events.filter((e) => e.type === ROBOT_EVENT.conflictResolved).map((e) => e.created_at),
  );
  if (events.some((e) => e.type === ROBOT_EVENT.visualReviewed && e.created_at > boundary)) return null;
  const captures = events.filter((e) => e.type === ROBOT_EVENT.visualCaptured && parse(e).prNumber === prNumber);
  const latestCapture = captures[captures.length - 1];
  return {
    ticketId: t.id,
    displayId: t.display_id,
    title: t.title,
    prNumber,
    prUrl,
    reasons: requests.map((r) => ({ by: parse(r).by ?? 'robot', reason: parse(r).reason ?? '' })),
    shots: latestCapture ? (parse(latestCapture).shots ?? []) : [],
    capturedAt: latestCapture ? latestCapture.created_at : null,
    requestedAt: requests[requests.length - 1].created_at,
  };
}

export function listAwaitingVisual(db: Database.Database): AwaitingVisualItem[] {
  const tickets = db
    .prepare(
      `SELECT id, display_id, title FROM agent_tickets
        WHERE archived_at IS NULL AND assignee = 'robot' AND agent_state = 'in-review'`,
    )
    .all() as TicketRow[];
  return tickets
    .map((t) => pendingFor(db, t))
    .filter((x): x is AwaitingVisualItem => x !== null)
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

export type VisualReviewResult =
  | { ok: true; eventId: number }
  | { ok: false; reason: 'not_found' | 'not_waiting' };

/** Record Steve's visual verdict on a ticket's PR, and clear the waiting notification. */
export function recordVisualReview(
  db: Database.Database,
  ticketId: number,
  approved: boolean,
  note: string,
  now: number = Date.now(),
): VisualReviewResult {
  const t = db.prepare('SELECT id, display_id, title FROM agent_tickets WHERE id = ? AND archived_at IS NULL').get(ticketId) as
    | TicketRow
    | undefined;
  if (!t) return { ok: false, reason: 'not_found' };
  const pending = pendingFor(db, t);
  if (!pending) return { ok: false, reason: 'not_waiting' };
  const detail: RobotEventDetail = { prNumber: pending.prNumber, approved, ...(note.trim() ? { note: note.trim().slice(0, 2000) } : {}) };
  const res = db
    .prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(ticketId, ROBOT_EVENT.visualReviewed, JSON.stringify(detail), now);
  db.prepare("UPDATE agent_notifications SET read_at = ? WHERE ticket_id = ? AND kind = 'agent_visual_review' AND read_at IS NULL").run(
    now,
    ticketId,
  );
  return { ok: true, eventId: Number(res.lastInsertRowid) };
}
