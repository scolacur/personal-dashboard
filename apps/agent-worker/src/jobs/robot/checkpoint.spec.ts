import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { currentEpisode, dispatchStart, firstWindow } from './checkpoint';
import { ensureRunsTable, finishRun, startRun } from './runs';

/** PD-964 (D-114): episodes, how a run starts, and the window plan. */

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  ensureRunsTable(db);
  db.exec(`CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, type TEXT, detail TEXT, created_at INTEGER)`);
  return db;
}
const event = (db: Database.Database, type: string, at: number, detail: object = {}): void => {
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (1, ?, ?, ?)').run(type, JSON.stringify(detail), at);
};
const run = (db: Database.Database, at: number, fin: Parameters<typeof finishRun>[2]): void => {
  const id = startRun(db, { ticketId: 1, issueNumber: null, branch: 'robot/1' }, at);
  finishRun(db, id, fin, at + 1);
};

describe('currentEpisode', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('with no boundary, the whole history is one episode', () => {
    run(db, 100, { status: 'error', turns: 10, faultTier: 'transient' });
    run(db, 200, { status: 'error', turns: 7, faultTier: 'transient' });
    expect(currentEpisode(db, 1)).toEqual({ start: 0, startedBy: null, turnsUsed: 17 });
  });

  it('a Continue starts a new episode; earlier turns stop counting', () => {
    run(db, 100, { status: 'checkpoint', turns: 26 });
    event(db, 'robot_checkpoint_continue', 150);
    run(db, 200, { status: 'error', turns: 9, faultTier: 'transient' });
    expect(currentEpisode(db, 1)).toEqual({ start: 150, startedBy: 'robot_checkpoint_continue', turnsUsed: 9 });
  });

  it('a retry is NOT a boundary — the total carries across it', () => {
    event(db, 'robot_unstick', 50);
    run(db, 100, { status: 'error', turns: 30, faultTier: 'transient' });
    run(db, 200, { status: 'no-verify', turns: 20, faultTier: 'transient' });
    expect(currentEpisode(db, 1).turnsUsed).toBe(50);
  });

  it('counts an in-flight run by its live turns', () => {
    const id = startRun(db, { ticketId: 1, issueNumber: null, branch: 'b' }, 100);
    db.prepare('UPDATE agent_runs SET turns = 12 WHERE id = ?').run(id);
    expect(currentEpisode(db, 1).turnsUsed).toBe(12);
  });
});

describe('dispatchStart', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('fresh for a ticket with no runs', () => {
    expect(dispatchStart(db, 1)).toEqual({ kind: 'fresh' });
  });

  it('continue / restart for the first run after Steve chose', () => {
    run(db, 100, { status: 'checkpoint', turns: 25 });
    event(db, 'robot_checkpoint', 101, { report: 'Left: tests' });
    event(db, 'robot_checkpoint_continue', 150);
    expect(dispatchStart(db, 1)).toEqual({ kind: 'continue', report: 'Left: tests' });
    event(db, 'robot_checkpoint_restart', 160);
    expect(dispatchStart(db, 1)).toEqual({ kind: 'restart' });
  });

  it('retry after a transient fault in a Continue keeps the Continue report and restores the WIP', () => {
    run(db, 100, { status: 'checkpoint', turns: 25 });
    event(db, 'robot_checkpoint', 101, { report: 'Blocking: nothing' });
    event(db, 'robot_checkpoint_continue', 150);
    run(db, 200, { status: 'error', faultTier: 'transient', faultReason: 'interrupted: worker graceful stop (SIGTERM)', wipRef: 'robot-wip/t1', wipSha: 's' });
    expect(dispatchStart(db, 1)).toEqual({ kind: 'retry', restoreWip: true, report: 'Blocking: nothing' });
  });

  it('retry with no WIP from the interrupted run does not restore (an older ref may predate a Restart)', () => {
    event(db, 'robot_checkpoint_restart', 50);
    run(db, 100, { status: 'error', faultTier: 'transient', faultReason: 'interrupted', outputTail: 'tail text' });
    const s = dispatchStart(db, 1);
    expect(s).toMatchObject({ kind: 'retry', restoreWip: false });
    expect(s.kind === 'retry' && s.report).toContain('tail text');
  });

  it('a deterministic fault is not a retry', () => {
    run(db, 100, { status: 'error', faultTier: 'deterministic' });
    expect(dispatchStart(db, 1)).toEqual({ kind: 'fresh' });
  });

  it('a run after a human boundary that ended normally is fresh', () => {
    run(db, 100, { status: 'handed-off', turns: 20 });
    event(db, 'robot_reactivated', 150);
    expect(dispatchStart(db, 1)).toEqual({ kind: 'fresh' });
  });
});

describe('firstWindow', () => {
  it('a fresh episode opens with the longer window', () => {
    expect(firstWindow(0, 50, 25, 200)).toEqual({ turns: 50, index: 1 });
  });

  it('checks land at 50, then every 25 after', () => {
    expect(firstWindow(50, 50, 25, 200)).toEqual({ turns: 25, index: 2 });
    expect(firstWindow(75, 50, 25, 200)).toEqual({ turns: 25, index: 3 });
  });

  it('a retry finishes the window it was cut short in', () => {
    expect(firstWindow(10, 50, 25, 200)).toEqual({ turns: 40, index: 1 });
    expect(firstWindow(60, 50, 25, 200)).toEqual({ turns: 15, index: 2 });
    expect(firstWindow(110, 50, 25, 200)).toEqual({ turns: 15, index: 4 });
  });

  it('equal opening and window lengths behave as fixed windows', () => {
    expect(firstWindow(0, 25, 25, 200)).toEqual({ turns: 25, index: 1 });
    expect(firstWindow(60, 25, 25, 200)).toEqual({ turns: 15, index: 3 });
  });

  it('never runs past the total cap', () => {
    expect(firstWindow(190, 50, 25, 200)).toEqual({ turns: 10, index: 7 });
    expect(firstWindow(40, 50, 25, 45)).toEqual({ turns: 5, index: 1 });
    expect(firstWindow(200, 50, 25, 200).turns).toBe(0);
    expect(firstWindow(230, 50, 25, 200).turns).toBe(0);
  });
});
