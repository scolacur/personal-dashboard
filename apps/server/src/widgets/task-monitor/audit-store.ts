import type Database from 'better-sqlite3';
import type { AuditFinding, AuditRun, AuditRunCounts } from '@dashboard/shared';

// Read/insert helpers for the Ticket Audit engine (D-045, PD-283). The web process owns
// `requested`-run creation (cron + POST) and the read endpoints; the agent-worker owns the
// claim → run → finish half (see apps/agent-worker/src/jobs/audit). Both hit the same
// `audit_run` / `audit_finding` tables declared in schema.ts.

interface AuditRunRow {
  id: number;
  status: string;
  scope: string | null;
  model: string | null;
  counts: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

interface AuditFindingRow {
  id: number;
  run_id: number;
  project_id: number | null;
  ticket_id: number | null;
  type: string;
  recommendation: string | null;
  reason: string | null;
  evidence: string | null;
  proposed_change: string | null;
  confidence: string | null;
  decision: string;
  created_at: number;
  updated_at: number;
}

function rowToRun(r: AuditRunRow): AuditRun {
  return {
    id: r.id,
    status: r.status as AuditRun['status'],
    scope: r.scope,
    model: r.model,
    counts: r.counts ? (JSON.parse(r.counts) as AuditRunCounts) : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

function rowToFinding(r: AuditFindingRow): AuditFinding {
  return {
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    ticketId: r.ticket_id,
    type: r.type,
    recommendation: r.recommendation,
    reason: r.reason,
    evidence: r.evidence,
    proposedChange: r.proposed_change,
    confidence: r.confidence,
    decision: r.decision as AuditFinding['decision'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Insert a `requested` run unless one is already pending or running (coalesce — Done-When
 * #3). better-sqlite3 is synchronous, so the check-then-insert can't interleave with another
 * caller within the process. Returns the run and whether it was freshly created.
 */
export function insertRequestedRunIfNone(
  db: Database.Database,
  scope: string | null = null,
): { run: AuditRun; created: boolean } {
  const existing = db
    .prepare("SELECT * FROM audit_run WHERE status IN ('requested', 'running') ORDER BY id LIMIT 1")
    .get() as AuditRunRow | undefined;
  if (existing) return { run: rowToRun(existing), created: false };

  const res = db
    .prepare("INSERT INTO audit_run (status, scope, created_at) VALUES ('requested', ?, ?)")
    .run(scope, Date.now());
  const row = db
    .prepare('SELECT * FROM audit_run WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as AuditRunRow;
  return { run: rowToRun(row), created: true };
}

export function listRuns(db: Database.Database): AuditRun[] {
  const rows = db.prepare('SELECT * FROM audit_run ORDER BY id DESC').all() as AuditRunRow[];
  return rows.map(rowToRun);
}

export function getRun(db: Database.Database, id: number): AuditRun | null {
  const row = db.prepare('SELECT * FROM audit_run WHERE id = ?').get(id) as AuditRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listFindings(db: Database.Database, runId: number): AuditFinding[] {
  const rows = db
    .prepare('SELECT * FROM audit_finding WHERE run_id = ? ORDER BY id ASC')
    .all(runId) as AuditFindingRow[];
  return rows.map(rowToFinding);
}
