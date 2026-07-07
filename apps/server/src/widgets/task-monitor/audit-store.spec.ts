import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { getRun, insertRequestedRunIfNone, listFindings, listRuns } from './audit-store';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  bootstrapSchema(db);
});

function insertFinding(db: Database.Database, runId: number, type: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit_finding (run_id, type, decision, created_at, updated_at)
     VALUES (?, ?, 'undecided', ?, ?)`,
  ).run(runId, type, now, now);
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
  });
});
