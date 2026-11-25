import type Database from 'better-sqlite3';
import type {
  AuditFinding,
  AuditRun,
  AuditRunCounts,
  FindingDecision,
  TicketPriority,
} from '@dashboard/shared';
import { archiveTicket, updateTicket } from './store';

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
  decision_reason: string | null;
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
    decisionReason: r.decision_reason,
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

export function getFinding(db: Database.Database, id: number): AuditFinding | null {
  const row = db.prepare('SELECT * FROM audit_finding WHERE id = ?').get(id) as
    | AuditFindingRow
    | undefined;
  return row ? rowToFinding(row) : null;
}

// ── Apply mechanics (PD-826, D-045) ────────────────────────────────────────────
// The decision → mutation path. HUMAN-INITIATED in the web process — the agent never writes a
// ticket (D-045). Accepting an actionable finding performs the SINGLE corresponding ticket mutation
// by reusing the existing store fns (no new ticket endpoints); rejecting records the human's reason.

/** Finding-decision failures that map to a 4xx (mirrors EpicGuardError's shape). */
export class FindingDecisionError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_ACTIONABLE'
      | 'UPDATE_UNSUPPORTED'
      | 'NO_TICKET'
      | 'PRIORITY_REQUIRED'
      | 'TICKET_MUTATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'FindingDecisionError';
  }
}

// Recommendation buckets Accept can act on in this slice. `keep` is non-actionable; `update`
// (UPDATE_DESCRIPTION diff-confirm) is the blocked sibling slice — rejected-only here.
const ACCEPT_SUPPORTED_TYPES: ReadonlySet<string> = new Set(['archive', 'complete', 'reprioritize']);

export interface SetFindingDecision {
  decision: FindingDecision;
  reason?: string | null;
  targetPriority?: TicketPriority | null;
}

/**
 * Record a human decision on an audit finding, and — when accepting an actionable finding —
 * perform the single ticket mutation, all in ONE transaction so the ticket write and the
 * `decision` flip can never half-apply (Done-When #2). Returns the updated finding.
 *
 * Accept mutations reuse the existing store fns (no new ticket-mutation endpoints):
 *   archive → archiveTicket, complete → status='completed', reprioritize → priority=targetPriority.
 * `keep` has no Accept; `update` is the blocked sibling slice (rejected-only here). A reject
 * records `decisionReason`; any non-reject decision clears it.
 */
export function setFindingDecision(
  db: Database.Database,
  findingId: number,
  input: SetFindingDecision,
): AuditFinding {
  const apply = db.transaction((): AuditFinding => {
    const finding = getFinding(db, findingId);
    if (!finding) throw new FindingDecisionError('NOT_FOUND', 'finding not found');

    if (input.decision === 'accepted') {
      if (finding.type === 'update') {
        throw new FindingDecisionError(
          'UPDATE_UNSUPPORTED',
          'accepting an update finding is not supported yet (sibling slice)',
        );
      }
      if (!ACCEPT_SUPPORTED_TYPES.has(finding.type)) {
        throw new FindingDecisionError(
          'NOT_ACTIONABLE',
          `a '${finding.type}' finding cannot be accepted`,
        );
      }
      if (finding.ticketId === null) {
        throw new FindingDecisionError('NO_TICKET', 'finding has no ticket to act on');
      }

      if (finding.type === 'archive') {
        if (!archiveTicket(db, finding.ticketId)) {
          throw new FindingDecisionError(
            'TICKET_MUTATION_FAILED',
            'ticket could not be archived (already archived or missing)',
          );
        }
      } else if (finding.type === 'complete') {
        if (!updateTicket(db, finding.ticketId, { status: 'completed' })) {
          throw new FindingDecisionError('TICKET_MUTATION_FAILED', 'ticket could not be completed');
        }
      } else if (finding.type === 'reprioritize') {
        if (!input.targetPriority) {
          throw new FindingDecisionError(
            'PRIORITY_REQUIRED',
            'accepting a reprioritize finding needs a targetPriority',
          );
        }
        if (!updateTicket(db, finding.ticketId, { priority: input.targetPriority })) {
          throw new FindingDecisionError(
            'TICKET_MUTATION_FAILED',
            'ticket priority could not be set',
          );
        }
      }
    }

    const decisionReason = input.decision === 'rejected' ? (input.reason ?? null) : null;
    db.prepare(
      'UPDATE audit_finding SET decision = ?, decision_reason = ?, updated_at = ? WHERE id = ?',
    ).run(input.decision, decisionReason, Date.now(), findingId);

    return getFinding(db, findingId)!;
  });
  return apply();
}
