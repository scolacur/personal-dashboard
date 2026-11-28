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

/** A project the audit fan-out visits (PD-284). Minimal — the agent grounds against the repo. */
export interface AuditProject {
  id: number;
  key: string | null;
  name: string;
}

/**
 * Every project the "all" fan-out should audit (PD-284, D-045): has at least one active
 * (un-archived, backlog/prioritized/queue) ticket AND `audit_enabled = 1` (per-project pause).
 * A disabled project is excluded here, so it never costs an agent turn (Done-When #4).
 */
export function auditableProjects(db: Database.Database): AuditProject[] {
  return db
    .prepare(
      `SELECT p.id AS id, p.key AS key, p.name AS name
         FROM agent_projects p
        WHERE p.audit_enabled = 1
          AND EXISTS (
            SELECT 1 FROM agent_tickets t
             WHERE t.project_id = p.id AND t.archived_at IS NULL
               AND t.status IN ('backlog', 'prioritized', 'queue')
          )
        ORDER BY p.id ASC`,
    )
    .all() as AuditProject[];
}

/**
 * The project a `single:<KEY>` scope targets (PD-284). An explicit single-project request
 * overrides the `audit_enabled` pause — it's a deliberate human ask for THIS project — so this
 * does not filter on the flag; the fan-out (`auditableProjects`) is what the pause governs.
 */
export function projectByKey(db: Database.Database, key: string): AuditProject | null {
  const row = db
    .prepare('SELECT id, key, name FROM agent_projects WHERE key = ?')
    .get(key) as AuditProject | undefined;
  return row ?? null;
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
 *  carry a prior run's decision forward, and `fingerprint` keys the next run's reconciliation. For
 *  a relation finding (PD-828) `targetTicketId` + `relationType` carry the other end + type; both
 *  are null on a single-ticket finding. */
export interface FindingInput {
  runId: number;
  projectId: number | null;
  ticketId: number | null;
  targetTicketId?: number | null;
  relationType?: string | null;
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
       (run_id, project_id, ticket_id, target_ticket_id, relation_type, type, recommendation,
        reason, evidence, proposed_change, confidence, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'undecided', ?, ?)`,
  ).run(
    f.runId,
    f.projectId,
    f.ticketId,
    f.targetTicketId ?? null,
    f.relationType ?? null,
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
 * One existing relation touching an audited ticket, resolved to the other end (PD-828). The audit
 * reads these as truth: they are injected into the prompt so the agent does not re-propose a link
 * that already exists, and they let an `unlink` finding resolve a target that is no longer in the
 * active audit surface (e.g. a `relates` link to an already-archived ticket).
 *
 * `subjectId` is the audited ticket; `direction: 'from'` means it is the relation's `from_ticket_id`
 * (it blocks / duplicates / splits into the other), `'to'` means it is the `to_ticket_id`.
 */
export interface AuditRelation {
  subjectId: number;
  otherId: number;
  otherDisplayId: string | null;
  otherStatus: string;
  type: string;
  direction: 'from' | 'to';
}

/** Load every relation where one audited ticket is an endpoint, resolved to the far end. Mirrors
 *  `listRelations` in the server store, but as the worker's own SQL (it can't import the store). */
export function getRelationsForTickets(db: Database.Database, ticketIds: number[]): AuditRelation[] {
  if (ticketIds.length === 0) return [];
  const placeholders = ticketIds.map(() => '?').join(',');
  const outgoing = db
    .prepare(
      `SELECT r.from_ticket_id AS subject, r.type AS type,
              t.id AS other, t.display_id AS other_display_id, t.status AS other_status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.to_ticket_id
        WHERE r.from_ticket_id IN (${placeholders})`,
    )
    .all(...ticketIds) as RelationEndpointRow[];
  const incoming = db
    .prepare(
      `SELECT r.to_ticket_id AS subject, r.type AS type,
              t.id AS other, t.display_id AS other_display_id, t.status AS other_status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.from_ticket_id
        WHERE r.to_ticket_id IN (${placeholders})`,
    )
    .all(...ticketIds) as RelationEndpointRow[];
  const toRel = (row: RelationEndpointRow, direction: 'from' | 'to'): AuditRelation => ({
    subjectId: row.subject,
    otherId: row.other,
    otherDisplayId: row.other_display_id,
    otherStatus: row.other_status,
    type: row.type,
    direction,
  });
  return [...outgoing.map((r) => toRel(r, 'from')), ...incoming.map((r) => toRel(r, 'to'))];
}

interface RelationEndpointRow {
  subject: number;
  other: number;
  other_display_id: string | null;
  other_status: string;
  type: string;
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

/** PD-284: token + cost totals summed across a run's agent turns, written on finish. */
export interface AuditRunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * PD-284: write the authoritative token/cost totals onto `audit_run`. Guarded like
 * `recordAuditRunUsage`: if the columns don't exist yet (worker deployed before the server
 * migration) this is a no-op rather than a crash, so `finishRun` still closes the run normally.
 */
export function recordAuditRunCost(db: Database.Database, id: number, usage: AuditRunUsage): void {
  const cols = db.prepare('PRAGMA table_info(audit_run)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'cost_usd')) return;
  db.prepare(
    'UPDATE audit_run SET input_tokens = ?, output_tokens = ?, total_tokens = ?, cost_usd = ? WHERE id = ?',
  ).run(usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.costUsd, id);
}

/**
 * Close out a claimed run. `model` is stamped so the report can show what produced it; `scope`
 * records what was actually audited (`single:<KEY>` or `all`, PD-284) — when omitted the stored
 * scope is left untouched (`COALESCE`), so a run created with a scope keeps it. `usage` (PD-284) is
 * the summed token/cost total; it is written via `recordAuditRunCost` (a separate, column-guarded
 * statement) so a pre-migration DB still closes the run.
 */
export function finishRun(
  db: Database.Database,
  id: number,
  status: 'done' | 'error',
  opts: {
    counts?: AuditRunCounts | null;
    model?: string | null;
    scope?: string | null;
    usage?: AuditRunUsage | null;
  } = {},
): void {
  db.prepare(
    'UPDATE audit_run SET status = ?, finished_at = ?, counts = ?, model = ?, scope = COALESCE(?, scope) WHERE id = ?',
  ).run(
    status,
    Date.now(),
    opts.counts ? JSON.stringify(opts.counts) : null,
    opts.model ?? null,
    opts.scope ?? null,
    id,
  );
  if (opts.usage) recordAuditRunCost(db, id, opts.usage);
}
