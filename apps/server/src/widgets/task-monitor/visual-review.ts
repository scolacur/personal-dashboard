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
 * Steve's side of the visual-review gate (PD-773 slice 2): which PRs are waiting for his visual
 * check, and recording his answer. Robot PRs, and since PD-915 session PRs too (`pendingForSession`).
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

/**
 * The server's mirror of the two GitHub repo variables that switch auto-merge on (PD-795):
 * `AUTO_MERGE_ROBOT` for `robot/*` PRs, `AUTO_MERGE_ALL` for every other PR, each on only when set
 * to exactly `on` (the same rule `.github/workflows/robot-auto-merge.yml` applies). The server
 * cannot read a repo variable, so these env vars MUST be kept in sync with the repo variables of the
 * same name by hand — if they drift, the Approve button's "merge PR" wording is the only thing that
 * is wrong; the merge itself is still decided by the workflow.
 */
export function autoMergeOn(isRobotPr: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return (isRobotPr ? env.AUTO_MERGE_ROBOT : env.AUTO_MERGE_ALL) === 'on';
}

/**
 * Whether the Evaluator has shipped the PR's current head (PD-795), from the `robot_evaluated`
 * timeline events after the review boundary. Mirrors the worker's "ship from every lens" review-gate
 * rule (D-101) using only what the server can see: the latest verdict per lens for this head is
 * `ship`, and at least one lens produced a verdict. Events arrive in `created_at, id` order, so the
 * last one seen for a lens is its latest.
 */
export function evaluatorShipped(events: Ev[], prNumber: number, boundary: number): boolean {
  const shipByLens = new Map<string, boolean>();
  for (const e of events) {
    if (e.type !== ROBOT_EVENT.evaluated || e.created_at <= boundary) continue;
    const d = parse(e);
    if (d.prNumber !== prNumber) continue;
    shipByLens.set(d.lens ?? 'code', d.verdict === 'ship');
  }
  return shipByLens.size > 0 && [...shipByLens.values()].every((ship) => ship);
}

interface TicketRow {
  id: number;
  display_id: string | null;
  title: string;
  assignee?: string | null;
  agent_state?: string | null;
  status?: string;
  repo?: string | null;
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
        WHERE ticket_id = ? AND type IN (?, ?, ?, ?, ?, ?) ORDER BY created_at, id`,
    )
    .all(
      t.id,
      ROBOT_EVENT.handoff,
      ROBOT_EVENT.conflictResolved,
      ROBOT_EVENT.visualReviewRequested,
      ROBOT_EVENT.visualReviewed,
      ROBOT_EVENT.visualCaptured,
      ROBOT_EVENT.evaluated,
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
    mergesOnApprove: evaluatorShipped(events, prNumber, boundary) && autoMergeOn(true),
  };
}

/**
 * The pending visual check on a **session** PR (PD-915): one Steve opened, not handed off by a Robot.
 * Same rule with a different boundary: the start of the Evaluator's latest review of the PR (its
 * newest `robot_evaluating`), since there is no hand-off. Mirrors the worker's `sessionReviewBoundary`.
 */
function pendingForSession(db: Database.Database, t: TicketRow, now: number): AwaitingVisualItem | null {
  const events = db
    .prepare(
      `SELECT id, ticket_id, type, detail, created_at FROM agent_ticket_events
        WHERE ticket_id = ? AND type IN (?, ?, ?, ?, ?) ORDER BY created_at, id`,
    )
    .all(
      t.id,
      ROBOT_EVENT.evaluating,
      ROBOT_EVENT.visualReviewRequested,
      ROBOT_EVENT.visualReviewed,
      ROBOT_EVENT.visualCaptured,
      ROBOT_EVENT.evaluated,
    ) as Ev[];
  const allRequests = events.filter((e) => e.type === ROBOT_EVENT.visualReviewRequested);
  const prNumber = allRequests.length > 0 ? (parse(allRequests[allRequests.length - 1]).prNumber ?? null) : null;
  if (prNumber === null) return null;
  const requests = allRequests.filter((e) => parse(e).prNumber === prNumber);
  const reviews = events.filter((e) => e.type === ROBOT_EVENT.evaluating && parse(e).prNumber === prNumber);
  if (reviews.length === 0) return null;
  const boundary = reviews[reviews.length - 1].created_at;
  if (events.some((e) => e.type === ROBOT_EVENT.visualReviewed && e.created_at > boundary)) return null;
  const captures = events.filter((e) => e.type === ROBOT_EVENT.visualCaptured && parse(e).prNumber === prNumber);
  const latestCapture = captures[captures.length - 1];
  return {
    ticketId: t.id,
    displayId: t.display_id,
    title: t.title,
    prNumber,
    prUrl: t.repo ? `https://github.com/${t.repo}/pull/${prNumber}` : null,
    reasons: requests.map((r) => ({ by: parse(r).by ?? 'robot', reason: parse(r).reason ?? '' })),
    shots: latestCapture ? (parse(latestCapture).shots ?? []) : [],
    stepFailures: latestCapture ? (parse(latestCapture).failures ?? []) : [],
    capturedAt: latestCapture ? latestCapture.created_at : null,
    requestedAt: requests[requests.length - 1].created_at,
    capture: captureStateFor(db, prNumber, boundary, now),
    mergesOnApprove: evaluatorShipped(events, prNumber, boundary) && autoMergeOn(false),
  };
}

/** A Robot ticket in review uses the hand-off rule; a ticket the Robot does not hold, the session rule. */
function pendingAny(db: Database.Database, t: TicketRow, now: number): AwaitingVisualItem | null {
  if (t.assignee === 'robot' && t.agent_state === 'in-review') return pendingFor(db, t, now);
  if (t.assignee === 'robot' && t.agent_state) return null;
  if (t.status === 'completed' || t.status === 'closed') return null;
  return pendingForSession(db, t, now);
}

const TICKET_COLUMNS = `t.id, t.display_id, t.title, t.assignee, t.agent_state, t.status, p.github_repo AS repo
   FROM agent_tickets t LEFT JOIN agent_projects p ON p.id = t.project_id`;

export function listAwaitingVisual(db: Database.Database, now: number = Date.now()): AwaitingVisualItem[] {
  const tickets = db
    .prepare(
      `SELECT ${TICKET_COLUMNS}
        WHERE t.archived_at IS NULL
          AND ((t.assignee = 'robot' AND t.agent_state = 'in-review')
               OR EXISTS (SELECT 1 FROM agent_ticket_events e WHERE e.ticket_id = t.id AND e.type = ?))`,
    )
    .all(ROBOT_EVENT.visualReviewRequested) as TicketRow[];
  return tickets
    .map((t) => pendingAny(db, t, now))
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
  const t = db.prepare(`SELECT ${TICKET_COLUMNS} WHERE t.id = ? AND t.archived_at IS NULL`).get(ticketId) as TicketRow | undefined;
  if (!t) return { ok: false, reason: 'not_found' };
  const pending = pendingAny(db, t, now);
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
