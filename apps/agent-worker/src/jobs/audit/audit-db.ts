import type Database from 'better-sqlite3';
import type { AuditRunCounts, FindingDecision } from '@dashboard/shared';
import type { PriorFinding } from './reconcile';

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

/**
 * PD-285: true when `audit_finding` has the `fingerprint` column. The server owns the migration
 * (schema.ts) and either side can deploy first, so a worker running ahead of the migration must
 * fall back to the pre-fingerprint behaviour rather than crash on an INSERT/SELECT of the column.
 */
export function auditFindingHasFingerprint(db: Database.Database): boolean {
  const cols = db.prepare('PRAGMA table_info(audit_finding)').all() as { name: string }[];
  return cols.some((c) => c.name === 'fingerprint');
}

/** One advisory finding to persist. `decision` defaults to 'undecided' in the schema; PD-285 may
 *  carry a prior run's decision forward, and `fingerprint` keys the next run's reconciliation. */
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
  fingerprint?: string | null;
  decision?: FindingDecision;
}

export function insertFinding(db: Database.Database, f: FindingInput): void {
  const now = Date.now();
  const decision = f.decision ?? 'undecided';
  if (auditFindingHasFingerprint(db)) {
    db.prepare(
      `INSERT INTO audit_finding
         (run_id, project_id, ticket_id, type, recommendation, reason, evidence,
          proposed_change, confidence, fingerprint, decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      f.fingerprint ?? null,
      decision,
      now,
      now,
    );
    return;
  }
  // Pre-migration fallback: no fingerprint column yet. Carry-forward can't be keyed, so persist as
  // a fresh undecided finding exactly as before (the decision resets harmlessly next run).
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
 * PD-285: the single-ticket findings of the most recent prior `done` run for this project — the
 * carry-forward source for reconciliation. "Most recent prior run" = the highest-id `done`
 * `audit_run` that produced any finding for the project (each run audits one project today). Returns
 * [] when the column doesn't exist yet (worker ahead of the migration) or there is no prior run.
 */
export function getPriorFindings(db: Database.Database, projectId: number): PriorFinding[] {
  if (!auditFindingHasFingerprint(db)) return [];
  const rows = db
    .prepare(
      `SELECT ticket_id AS ticketId, type, fingerprint, decision
         FROM audit_finding
        WHERE project_id = ?
          AND run_id = (
            SELECT MAX(r.id) FROM audit_run r
             WHERE r.status = 'done'
               AND EXISTS (
                 SELECT 1 FROM audit_finding f WHERE f.run_id = r.id AND f.project_id = ?
               )
          )`,
    )
    .all(projectId, projectId) as {
    ticketId: number | null;
    type: string;
    fingerprint: string | null;
    decision: string;
  }[];
  return rows.map((r) => ({
    ticketId: r.ticketId,
    type: r.type,
    fingerprint: r.fingerprint,
    decision: r.decision as FindingDecision,
  }));
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
