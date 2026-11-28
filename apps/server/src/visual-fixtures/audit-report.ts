import type Database from 'better-sqlite3';

/**
 * Ticket Audit report fixture (PD-826): a completed audit run with a spread of findings, so the
 * report surface at `/devops/reports/ticket-audit` renders the Accept / Reject apply mechanics in a
 * capture — the confidence gate, the reprioritize selector, the reject form and the "Apply
 * accepted" batch control all need a `done` run with findings to show.
 *
 * Runs AFTER the task-tracker fixture (see VISUAL_FIXTURES order), so the tickets the findings point
 * at already exist. Findings are written with direct SQL — the web process has no finding-insert
 * store fn (the worker owns that); the fixture's spec reads them back via `listFindings`, which is
 * what breaks first if the audit_finding shape changes.
 */

interface FixtureFinding {
  type: string;
  recommendation: string;
  reason: string;
  confidence: string | null;
}

// A spread that exercises every branch of the apply UI:
//  - high archive/complete  → batch-eligible + one-click Accept
//  - high reprioritize      → selector pre-filled from the "to P1" recommendation
//  - low archive            → gated (must open to review before Accept)
//  - high update            → reject-only (the blocked sibling slice)
const FINDINGS: FixtureFinding[] = [
  { type: 'archive', recommendation: 'Archive — superseded by a newer ticket.', reason: 'No activity in 6 months and the feature shipped elsewhere.', confidence: 'high' },
  { type: 'complete', recommendation: 'Mark complete — the work already merged.', reason: 'The linked PR merged; nothing is left to do.', confidence: 'high' },
  { type: 'reprioritize', recommendation: 'Raise to P1 — it now blocks two queued tickets.', reason: 'Became a blocker after the Epic was re-scoped.', confidence: 'high' },
  { type: 'archive', recommendation: 'Possibly archive — looks stale.', reason: 'Unclear if still relevant; open it to check first.', confidence: 'low' },
  { type: 'update', recommendation: 'Rewrite the body against the four-section template.', reason: 'The acceptance checklist is missing.', confidence: 'high' },
];

export function seedAuditReport(db: Database.Database, now: number = Date.now()): void {
  const pd = db.prepare("SELECT id FROM agent_projects WHERE key = 'PD'").get() as
    | { id: number }
    | undefined;
  if (!pd) throw new Error('visual fixture: the PD project is missing (task-monitor schema not bootstrapped?)');

  const tickets = db
    .prepare('SELECT id FROM agent_tickets WHERE project_id = ? AND is_epic = 0 ORDER BY id LIMIT ?')
    .all(pd.id, FINDINGS.length) as { id: number }[];

  const runRes = db
    .prepare(
      `INSERT INTO audit_run (status, scope, model, counts, started_at, finished_at, created_at)
       VALUES ('done', 'single:PD', 'claude-opus', ?, ?, ?, ?)`,
    )
    .run(
      JSON.stringify({ projects: 1, tickets: tickets.length, findings: FINDINGS.length }),
      now - 60_000,
      now - 30_000,
      now - 60_000,
    );
  const runId = Number(runRes.lastInsertRowid);

  const insert = db.prepare(
    `INSERT INTO audit_finding
       (run_id, project_id, ticket_id, type, recommendation, reason, confidence, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'undecided', ?, ?)`,
  );
  FINDINGS.forEach((f, i) => {
    insert.run(
      runId,
      pd.id,
      tickets[i]?.id ?? null,
      f.type,
      f.recommendation,
      f.reason,
      f.confidence,
      now,
      now,
    );
  });
}

export function auditReportIsEmpty(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_run').get() as { n: number }).n === 0;
}
