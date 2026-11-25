import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  getFinding,
  getRun,
  insertRequestedRunIfNone,
  listFindings,
  listRuns,
  setFindingDecision,
  FindingDecisionError,
} from './audit-store';
import { createTicket, getTicket } from './store';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
});

function insertFinding(db: Database.Database, runId: number, type: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit_finding (run_id, type, decision, created_at, updated_at)
     VALUES (?, ?, 'undecided', ?, ?)`,
  ).run(runId, type, now, now);
}

function pdProjectId(db: Database.Database): number {
  return (db.prepare("SELECT id FROM agent_projects WHERE key = 'PD'").get() as { id: number }).id;
}

/** Insert a finding wired to a real ticket and return its id. */
function findingFor(
  db: Database.Database,
  runId: number,
  type: string,
  ticketId: number | null,
  confidence: string | null = 'high',
): number {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO audit_finding (run_id, project_id, ticket_id, type, confidence, decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'undecided', ?, ?)`,
    )
    .run(runId, null, ticketId, type, confidence, now, now);
  return Number(res.lastInsertRowid);
}

describe('bootstrapSchema — audit tables', () => {
  it('creates audit_run and audit_finding and is a no-op on a second run (Done-When #4)', () => {
    // Insert into the tables to prove they exist, then bootstrap again — must not throw or wipe.
    insertRequestedRunIfNone(db, 'single:PD');
    expect(() => bootstrapSchema(db)).not.toThrow();
    expect(listRuns(db)).toHaveLength(1);
  });
});

describe('insertRequestedRunIfNone', () => {
  it('creates a requested run when none exists', () => {
    const { run, created } = insertRequestedRunIfNone(db, 'single:PD');
    expect(created).toBe(true);
    expect(run.status).toBe('requested');
    expect(run.scope).toBe('single:PD');
  });

  it('coalesces: a second call while one is pending returns the existing run (Done-When #3)', () => {
    const first = insertRequestedRunIfNone(db);
    const second = insertRequestedRunIfNone(db);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(listRuns(db)).toHaveLength(1);
  });

  it('coalesces onto a running run too (not just requested)', () => {
    const { run } = insertRequestedRunIfNone(db);
    db.prepare("UPDATE audit_run SET status='running' WHERE id=?").run(run.id);
    const second = insertRequestedRunIfNone(db);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(run.id);
  });

  it('allows a new run once the prior one is done', () => {
    const { run } = insertRequestedRunIfNone(db);
    db.prepare("UPDATE audit_run SET status='done' WHERE id=?").run(run.id);
    const second = insertRequestedRunIfNone(db);
    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(run.id);
    expect(listRuns(db)).toHaveLength(2);
  });
});

describe('read helpers', () => {
  it('listRuns is newest-first; getRun round-trips counts JSON', () => {
    const a = insertRequestedRunIfNone(db).run;
    db.prepare("UPDATE audit_run SET status='done' WHERE id=?").run(a.id);
    const b = insertRequestedRunIfNone(db).run;
    db.prepare('UPDATE audit_run SET counts=? WHERE id=?').run(
      JSON.stringify({ projects: 1, tickets: 3, findings: 2, archive: 2 }),
      b.id,
    );
    const runs = listRuns(db);
    expect(runs.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(getRun(db, b.id)?.counts).toEqual({ projects: 1, tickets: 3, findings: 2, archive: 2 });
    expect(getRun(db, 9999)).toBeNull();
  });

  it('listFindings returns a run\'s findings in id order', () => {
    const { run } = insertRequestedRunIfNone(db);
    insertFinding(db, run.id, 'archive');
    insertFinding(db, run.id, 'reprioritize');
    const findings = listFindings(db, run.id);
    expect(findings.map((f) => f.type)).toEqual(['archive', 'reprioritize']);
    expect(findings[0].decision).toBe('undecided');
    expect(findings[0].decisionReason).toBeNull();
  });
});

describe('setFindingDecision — apply mechanics (PD-826)', () => {
  function newRun(): number {
    const { run } = insertRequestedRunIfNone(db);
    return run.id;
  }

  it('accepting an archive finding archives the ticket AND flips decision, atomically (Done-When #2)', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Stale ticket', projectId: pd });
    const fid = findingFor(db, newRun(), 'archive', ticket.id);

    const updated = setFindingDecision(db, fid, { decision: 'accepted' });
    expect(updated.decision).toBe('accepted');
    expect(getTicket(db, ticket.id)?.archivedAt).not.toBeNull();
  });

  it('accepting a complete finding sets status=completed AND flips decision', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Already done', projectId: pd });
    const fid = findingFor(db, newRun(), 'complete', ticket.id);

    setFindingDecision(db, fid, { decision: 'accepted' });
    expect(getTicket(db, ticket.id)?.status).toBe('completed');
    expect(getFinding(db, fid)?.decision).toBe('accepted');
  });

  it('accepting a reprioritize finding sets the target priority', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Bump me', projectId: pd, priority: 'P4' });
    const fid = findingFor(db, newRun(), 'reprioritize', ticket.id);

    setFindingDecision(db, fid, { decision: 'accepted', targetPriority: 'P1' });
    expect(getTicket(db, ticket.id)?.priority).toBe('P1');
    expect(getFinding(db, fid)?.decision).toBe('accepted');
  });

  it('refuses to accept a reprioritize finding without a targetPriority (and leaves the ticket)', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Needs a level', projectId: pd, priority: 'P4' });
    const fid = findingFor(db, newRun(), 'reprioritize', ticket.id);

    expect(() => setFindingDecision(db, fid, { decision: 'accepted' })).toThrow(FindingDecisionError);
    expect(getTicket(db, ticket.id)?.priority).toBe('P4');
    expect(getFinding(db, fid)?.decision).toBe('undecided');
  });

  it('refuses to accept an update finding (blocked sibling slice)', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Rewrite body', projectId: pd });
    const fid = findingFor(db, newRun(), 'update', ticket.id);
    try {
      setFindingDecision(db, fid, { decision: 'accepted' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FindingDecisionError);
      expect((e as FindingDecisionError).code).toBe('UPDATE_UNSUPPORTED');
    }
  });

  it('refuses to accept a non-actionable keep finding', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Leave alone', projectId: pd });
    const fid = findingFor(db, newRun(), 'keep', ticket.id);
    try {
      setFindingDecision(db, fid, { decision: 'accepted' });
      expect.unreachable();
    } catch (e) {
      expect((e as FindingDecisionError).code).toBe('NOT_ACTIONABLE');
    }
  });

  it('rejecting flips decision to rejected and persists the reason (Done-When #3)', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Keep it', projectId: pd });
    const fid = findingFor(db, newRun(), 'archive', ticket.id);

    const updated = setFindingDecision(db, fid, { decision: 'rejected', reason: 'still relevant' });
    expect(updated.decision).toBe('rejected');
    expect(updated.decisionReason).toBe('still relevant');
    // ticket untouched by a reject
    expect(getTicket(db, ticket.id)?.archivedAt).toBeNull();
  });

  it('a non-reject decision clears any reason', () => {
    const pd = pdProjectId(db);
    const ticket = createTicket(db, { title: 'Done', projectId: pd });
    const fid = findingFor(db, newRun(), 'complete', ticket.id);
    const updated = setFindingDecision(db, fid, { decision: 'accepted', reason: 'ignored' });
    expect(updated.decisionReason).toBeNull();
  });

  it('throws NOT_FOUND for a missing finding', () => {
    try {
      setFindingDecision(db, 9999, { decision: 'accepted' });
      expect.unreachable();
    } catch (e) {
      expect((e as FindingDecisionError).code).toBe('NOT_FOUND');
    }
  });

  it('decision_reason is added to a pre-PD-826 audit_finding table on re-bootstrap (Done-When #6)', () => {
    // Simulate a DB that predates the column: bootstrap, then roll BOTH the column and its
    // migration-ledger row back to the pre-PD-826 state, so the next bootstrap must re-run the
    // addColumn migration rather than relying on the CREATE TABLE (which only fires on a fresh DB).
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    bootstrapSchema(old);

    old.exec('ALTER TABLE audit_finding DROP COLUMN decision_reason');
    old.prepare('DELETE FROM _migrations WHERE id = ?').run('audit_finding_add_decision_reason');

    const before = old.prepare('PRAGMA table_info(audit_finding)').all() as { name: string }[];
    expect(before.some((c) => c.name === 'decision_reason')).toBe(false);

    // Re-bootstrap: the addColumn migration path is the only thing that can restore the column.
    bootstrapSchema(old);

    const after = old.prepare('PRAGMA table_info(audit_finding)').all() as { name: string }[];
    expect(after.some((c) => c.name === 'decision_reason')).toBe(true);

    // And the restored column is writable (nullable TEXT).
    const run = old
      .prepare(
        `INSERT INTO audit_run (status, scope, created_at) VALUES ('done', 'test', ?) RETURNING id`,
      )
      .get(Date.now()) as { id: number };
    old
      .prepare(
        `INSERT INTO audit_finding (run_id, type, decision, decision_reason, created_at, updated_at)
         VALUES (?, 'archive', 'rejected', 'not stale', ?, ?)`,
      )
      .run(run.id, Date.now(), Date.now());
    const row = old
      .prepare('SELECT decision_reason FROM audit_finding WHERE run_id = ?')
      .get(run.id) as { decision_reason: string | null };
    expect(row.decision_reason).toBe('not stale');
  });
});
