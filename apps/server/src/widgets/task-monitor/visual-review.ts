import type Database from 'better-sqlite3';
import {
  ROBOT_EVENT,
  VISUAL_CAPTURE_ENABLED_KEY,
  VISUAL_CAPTURE_HEARTBEAT_STALE_MS,
  type AwaitingVisualItem,
  type RobotEventDetail,
  type VisualCaptureState,
} from '@dashboard/shared';

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

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * What actually happened with capture for a PR's current head (PD-794). Both tables are worker-owned,
 * so either may not exist yet.
 *
 * The server never sees the head SHA, but every new head starts a new review boundary (a hand-off or
 * a conflict resolution), so the newest `visual_captures` row after the boundary is this head's.
 * An `off` row, or none, falls through to the worker's heartbeat: the server can't read the worker's
 * env, so the worker records whether capture is on in `robot_state` each tick.
 */
export function captureStateFor(db: Database.Database, prNumber: number, boundary: number, now: number): VisualCaptureState {
  if (tableExists(db, 'visual_captures')) {
    const row = db
      .prepare(
        `SELECT outcome, detail FROM visual_captures WHERE pr_number = ? AND created_at >= ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(prNumber, boundary) as { outcome: string; detail: string | null } | undefined;
    if (row?.outcome === 'captured') return { kind: 'captured' };
    if (row?.outcome === 'failed') return { kind: 'failed', reason: row.detail?.trim() || 'no reason recorded' };
    if (row?.outcome === 'skipped') return { kind: 'skipped', reason: row.detail?.trim() || 'no reason recorded' };
  }
  const beat = tableExists(db, 'robot_state')
    ? (db.prepare('SELECT value, updated_at FROM robot_state WHERE key = ?').get(VISUAL_CAPTURE_ENABLED_KEY) as
        | { value: string | null; updated_at: number }
        | undefined)
    : undefined;
  if (!beat || now - beat.updated_at > VISUAL_CAPTURE_HEARTBEAT_STALE_MS) return { kind: 'unknown', lastSeen: beat?.updated_at ?? null };
  return beat.value === '1' ? { kind: 'capturing', since: boundary } : { kind: 'off' };
}

/** The pending visual check for one in-review ticket, or null. */
function pendingFor(db: Database.Database, t: TicketRow, now: number): AwaitingVisualItem | null {
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
    stepFailures: latestCapture ? (parse(latestCapture).failures ?? []) : [],
    capturedAt: latestCapture ? latestCapture.created_at : null,
    requestedAt: requests[requests.length - 1].created_at,
    capture: captureStateFor(db, prNumber, boundary, now),
  };
}

export function listAwaitingVisual(db: Database.Database, now: number = Date.now()): AwaitingVisualItem[] {
  const tickets = db
    .prepare(
      `SELECT id, display_id, title FROM agent_tickets
        WHERE archived_at IS NULL AND assignee = 'robot' AND agent_state = 'in-review'`,
    )
    .all() as TicketRow[];
  return tickets
    .map((t) => pendingFor(db, t, now))
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
  const pending = pendingFor(db, t, now);
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
