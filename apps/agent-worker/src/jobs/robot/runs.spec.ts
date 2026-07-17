import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureRunsTable,
  startRun,
  finishRun,
  runCountForTicket,
  listRunsForTicket,
  failedRunsForTicket,
} from './runs';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  ensureRunsTable(db);
  return db;
}

describe('agent_runs', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('ensureRunsTable is idempotent', () => {
    expect(() => {
      ensureRunsTable(db);
      ensureRunsTable(db);
    }).not.toThrow();
  });

  it('startRun opens a running row and returns its id', () => {
    const id = startRun(db, { ticketId: 429, issueNumber: 220, branch: 'robot/220' }, 1000);
    expect(id).toBeGreaterThan(0);
    const [run] = listRunsForTicket(db, 429);
    expect(run).toMatchObject({
      id,
      ticketId: 429,
      issueNumber: 220,
      branch: 'robot/220',
      status: 'running',
      startedAt: 1000,
      finishedAt: null,
      prUrl: null,
    });
  });

  it('finishRun records the terminal outcome', () => {
    const id = startRun(db, { ticketId: 1, issueNumber: null, branch: 'robot/x' }, 1000);
    finishRun(db, id, { status: 'handed-off', sessionId: 'sess-1', prUrl: 'https://pr/1' }, 2000);
    const [run] = listRunsForTicket(db, 1);
    expect(run.status).toBe('handed-off');
    expect(run.sessionId).toBe('sess-1');
    expect(run.prUrl).toBe('https://pr/1');
    expect(run.finishedAt).toBe(2000);
  });

  it('records failed runs too (so C2 can count attempts)', () => {
    const id = startRun(db, { ticketId: 7, issueNumber: null, branch: 'robot/7' });
    finishRun(db, id, { status: 'error', error: 'spawn failed' });
    const [run] = listRunsForTicket(db, 7);
    expect(run.status).toBe('error');
    expect(run.error).toBe('spawn failed');
  });

  it('runCountForTicket counts every attempt regardless of outcome', () => {
    expect(runCountForTicket(db, 5)).toBe(0);
    finishRun(db, startRun(db, { ticketId: 5, issueNumber: null, branch: 'b' }), { status: 'no-verify' });
    finishRun(db, startRun(db, { ticketId: 5, issueNumber: null, branch: 'b' }), { status: 'error' });
    startRun(db, { ticketId: 5, issueNumber: null, branch: 'b' }); // still running
    expect(runCountForTicket(db, 5)).toBe(3);
    expect(runCountForTicket(db, 999)).toBe(0);
  });

  it('listRunsForTicket returns newest first', () => {
    startRun(db, { ticketId: 3, issueNumber: null, branch: 'b' }, 1000);
    startRun(db, { ticketId: 3, issueNumber: null, branch: 'b' }, 2000);
    const runs = listRunsForTicket(db, 3);
    expect(runs.map((r) => r.startedAt)).toEqual([2000, 1000]);
  });

  it('persists the C2 fault classification + C3 metrics on a finished run', () => {
    const id = startRun(db, { ticketId: 9, issueNumber: null, branch: 'b' });
    finishRun(db, id, { status: 'error', faultTier: 'deterministic', faultSignature: 'sig', faultReason: 'why', turns: 8, tokens: 5100 });
    const [run] = listRunsForTicket(db, 9);
    expect(run).toMatchObject({ faultTier: 'deterministic', faultSignature: 'sig', faultReason: 'why', turns: 8, tokens: 5100 });
  });

  it('migrates a pre-C2 table (no fault columns) in place', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, issue_number INTEGER,
        branch TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, pr_url TEXT, error TEXT,
        started_at INTEGER NOT NULL, finished_at INTEGER
      );`);
    legacy.prepare(`INSERT INTO agent_runs (ticket_id, branch, status, started_at) VALUES (1, 'b', 'error', 1)`).run();
    expect(() => ensureRunsTable(legacy)).not.toThrow(); // adds the fault_* columns
    // a legacy failure with no fault_tier reads back as transient (safe/retryable), signature ← status
    expect(failedRunsForTicket(legacy, 1)).toEqual([{ tier: 'transient', signature: 'error', finishedAt: null, bodyHash: null }]);
  });

  it('failedRunsForTicket returns only failures (no successes / ask-human) in order', () => {
    finishRun(db, startRun(db, { ticketId: 2, issueNumber: null, branch: 'b' }, 1), { status: 'handed-off' });
    finishRun(db, startRun(db, { ticketId: 2, issueNumber: null, branch: 'b' }, 2), { status: 'ask-human', faultReason: 'q' });
    finishRun(db, startRun(db, { ticketId: 2, issueNumber: null, branch: 'b' }, 3), { status: 'no-verify', faultTier: 'transient', faultSignature: 'no-verify' });
    finishRun(db, startRun(db, { ticketId: 2, issueNumber: null, branch: 'b' }, 4), { status: 'error', faultTier: 'system-wide', faultSignature: 'auth' });
    expect(failedRunsForTicket(db, 2)).toEqual([
      { tier: 'transient', signature: 'no-verify', finishedAt: expect.any(Number), bodyHash: null },
      { tier: 'system-wide', signature: 'auth', finishedAt: expect.any(Number), bodyHash: null },
    ]);
  });

  it('a human reset boundary drops earlier failures from the count (C4/PD-345)', () => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER, type TEXT, detail TEXT, created_at INTEGER)',
    );
    finishRun(db, startRun(db, { ticketId: 1, issueNumber: null, branch: 'b' }, 100), { status: 'error', faultTier: 'transient', faultSignature: 'x' }, 150);
    finishRun(db, startRun(db, { ticketId: 1, issueNumber: null, branch: 'b' }, 200), { status: 'error', faultTier: 'transient', faultSignature: 'y' }, 250);
    expect(failedRunsForTicket(db, 1).length).toBe(2);

    // Reset at t=300 — everything before it stops counting, but the rows stay (history intact).
    db.prepare("INSERT INTO agent_ticket_events (ticket_id, type, created_at) VALUES (1, 'robot_reset', 300)").run();
    expect(failedRunsForTicket(db, 1)).toEqual([]);
    expect(listRunsForTicket(db, 1).length).toBe(2); // rows preserved

    // A failure after the reset counts again.
    finishRun(db, startRun(db, { ticketId: 1, issueNumber: null, branch: 'b' }, 400), { status: 'error', faultTier: 'transient', faultSignature: 'z' }, 450);
    expect(failedRunsForTicket(db, 1).length).toBe(1);
  });
});
