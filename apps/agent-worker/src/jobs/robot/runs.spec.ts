import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureRunsTable,
  startRun,
  finishRun,
  runCountForTicket,
  listRunsForTicket,
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
});
