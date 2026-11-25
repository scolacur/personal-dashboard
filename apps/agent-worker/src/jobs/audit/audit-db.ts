import type Database from 'better-sqlite3';
import { type AuditRunCounts, isActionableFindingType } from '@dashboard/shared';

// The agent-worker's half of the Ticket Audit tables (D-045, PD-283): claim a `requested`
// run, read the audited project's tickets, write findings, finish the run. The web process
// owns run creation + the read endpoints (apps/server/.../audit-store.ts). Same tables; this
// package can't import the server's store, so it holds its own SQL (mirrors the refine job).

/** A run this worker has just transitioned `requested` → `running`. */
export interface ClaimedRun {
  id: number;
  scope: string | null;
}

/**
 * Atomically claim the oldest `requested` run (Done-When #1). Two-step so the claim is
 * unambiguous: read the candidate id, then `UPDATE … WHERE id=? AND status='requested'`.
 * If a racing worker already flipped it, `changes` is 0 and we return null (lost the race).
 */
export function claimNextRun(db: Database.Database): ClaimedRun | null {
  const cand = db
    .prepare("SELECT id, scope FROM audit_run WHERE status = 'requested' ORDER BY id LIMIT 1")
    .get() as { id: number; scope: string | null } | undefined;
  if (!cand) return null;

  const res = db
    .prepare("UPDATE audit_run SET status = 'running', started_at = ? WHERE id = ? AND status = 'requested'")
    .run(Date.now(), cand.id);
  if (res.changes !== 1) return null;

  return { id: cand.id, scope: cand.scope };
}

/** A ticket handed to the audit agent. Kept minimal — the agent grounds against the repo. */
export interface AuditableTicket {
  id: number;
  displayId: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: string;
}

/** The project the tracer-bullet run audits: the lowest-id project with active tickets. */
export function firstProjectWithActiveTickets(
  db: Database.Database,
): { id: number; key: string | null; name: string } | null {
  const row = db
    .prepare(
      `SELECT p.id AS id, p.key AS key, p.name AS name
         FROM agent_projects p
        WHERE EXISTS (
          SELECT 1 FROM agent_tickets t
           WHERE t.project_id = p.id AND t.archived_at IS NULL
             AND t.status IN ('backlog', 'prioritized', 'queue')
        )
        ORDER BY p.id ASC
        LIMIT 1`,
    )
    .get() as { id: number; key: string | null; name: string } | undefined;
  return row ?? null;
}

/** Active, un-archived tickets for a project — the audit surface (D-045). */
export function getAuditableTickets(db: Database.Database, projectId: number): AuditableTicket[] {
  const rows = db
    .prepare(
      `SELECT id, display_id, title, body, status, priority
         FROM agent_tickets
        WHERE project_id = ? AND archived_at IS NULL
          AND status IN ('backlog', 'prioritized', 'queue')
        ORDER BY id ASC`,
    )
    .all(projectId) as {
    id: number;
    display_id: string | null;
    title: string;
    body: string | null;
    status: string;
    priority: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    displayId: r.display_id,
    title: r.title,
    body: r.body,
    status: r.status,
    priority: r.priority,
  }));
}

/** One advisory finding to persist. `decision` defaults to 'undecided' in the schema. */
export interface FindingInput {
  runId: number;
  projectId: number | null;
  ticketId: number | null;
  type: string;
  recommendation?: string | null;
  reason?: string | null;
  evidence?: string | null;
  proposedChange?: string | null;
  confidence?: string | null;
}

export function insertFinding(db: Database.Database, f: FindingInput): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit_finding
       (run_id, project_id, ticket_id, type, recommendation, reason, evidence,
        proposed_change, confidence, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'undecided', ?, ?)`,
  ).run(
    f.runId,
    f.projectId,
    f.ticketId,
    f.type,
    f.recommendation ?? null,
    f.reason ?? null,
    f.evidence ?? null,
    f.proposedChange ?? null,
    f.confidence ?? null,
    now,
    now,
  );
}

/**
 * PD-910: live progress on a running audit. `turns` / `tokens` are added to the server-owned
 * `audit_run` by a server migration; a worker deployed before that migration gets "no such column"
 * here, which the caller swallows (safeProgress) — the audit itself is never affected. Scoped to
 * `status = 'running'`; `COALESCE` keeps a known token total when this turn's is unknown.
 */
export function updateAuditRunProgress(db: Database.Database, id: number, turns: number, tokens?: number): void {
  db.prepare(
    "UPDATE audit_run SET turns = ?, tokens = COALESCE(?, tokens) WHERE id = ? AND status = 'running'",
  ).run(turns, tokens ?? null, id);
}

/**
 * PD-910: the authoritative totals off the agent's result message. A SEPARATE statement from
 * `finishRun` on purpose: if the columns don't exist yet (worker deployed before the server
 * migration) this one throws and is logged, while the run still closes normally.
 */
export function recordAuditRunUsage(db: Database.Database, id: number, usage: { turns?: number; tokens?: number }): void {
  if (usage.turns === undefined && usage.tokens === undefined) return;
  db.prepare('UPDATE audit_run SET turns = COALESCE(?, turns), tokens = COALESCE(?, tokens) WHERE id = ?').run(
    usage.turns ?? null,
    usage.tokens ?? null,
    id,
  );
}

/**
 * Raise the `audit_complete` notification for a finished run, following the refine-job precedent
 * of writing `agent_notifications` directly (the web `createNotification` isn't importable here)
 * (PD-851). Fires only when the run has ≥1 actionable finding (`type !== 'keep'`, the shared
 * `isActionableFindingType` rule) — a run with zero actionable findings (incl. the empty-project
 * exit / all-`keep`) inserts nothing and returns false.
 *
 * `audit_complete` is ticketless (`ticket_id = NULL`), so the server's dedup guard — which only
 * runs for ticket-scoped rows — is bypassed; we collapse explicitly instead: any existing UNREAD
 * `audit_complete` row is deleted first, so there is never more than one unread entry, and the
 * surviving row names the newest run (its report always shows the latest run).
 */
export function notifyAuditComplete(db: Database.Database, runId: number, now: number = Date.now()): boolean {
  const types = db.prepare('SELECT type FROM audit_finding WHERE run_id = ?').all(runId) as { type: string }[];
  const actionable = types.filter((t) => isActionableFindingType(t.type)).length;
  if (actionable === 0) return false;

  // Collapse to one unread: drop any prior unread audit_complete before inserting the fresh one.
  db.prepare("DELETE FROM agent_notifications WHERE kind = 'audit_complete' AND read_at IS NULL").run();

  const title = `Ticket Audit complete — ${actionable} finding${actionable === 1 ? '' : 's'} to review`;
  const body = `Run #${runId} surfaced ${actionable} actionable finding${actionable === 1 ? '' : 's'}.`;
  db.prepare(
    'INSERT INTO agent_notifications (kind, ticket_id, title, body, created_at) VALUES (?, NULL, ?, ?, ?)',
  ).run('audit_complete', title, body, now);
  return true;
}

/** Close out a claimed run. `model` is stamped so the report can show what produced it. */
export function finishRun(
  db: Database.Database,
  id: number,
  status: 'done' | 'error',
  opts: { counts?: AuditRunCounts | null; model?: string | null } = {},
): void {
  db.prepare('UPDATE audit_run SET status = ?, finished_at = ?, counts = ?, model = ? WHERE id = ?').run(
    status,
    Date.now(),
    opts.counts ? JSON.stringify(opts.counts) : null,
    opts.model ?? null,
    id,
  );
}
