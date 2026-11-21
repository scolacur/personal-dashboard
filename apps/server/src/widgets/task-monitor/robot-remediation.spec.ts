import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  continueCheckpoint,
  createTicket,
  getDispatchPauseState,
  getProjectBySlug,
  getTicket,
  listTicketEvents,
  resetRobotRuns,
  restartCheckpoint,
  setDispatchPaused,
} from './store';
import { ROBOT_EVENT, type RobotEventDetail } from '@dashboard/shared';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function seedStuck(db: Database.Database): number {
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no PD project');
  const t = createTicket(db, { title: 'stuck one', projectId: p.id });
  db.prepare("UPDATE agent_tickets SET status = 'queue', assignee = 'robot', agent_state = 'stuck' WHERE id = ?").run(t.id);
  return t.id;
}

describe('resetRobotRuns (C4 remediation)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('unstick re-queues a parked ticket and logs a robot_unstick event', () => {
    const id = seedStuck(db);
    const updated = resetRobotRuns(db, id, 'unstick');
    expect(updated?.agentState).toBe('queued');
    const types = listTicketEvents(db, id).map((e) => e.type);
    expect(types).toContain('robot_unstick');
  });

  it('reset re-queues and logs a robot_reset event (the retry-budget boundary)', () => {
    const id = seedStuck(db);
    resetRobotRuns(db, id, 'reset');
    expect(getTicket(db, id)?.agentState).toBe('queued');
    expect(listTicketEvents(db, id).map((e) => e.type)).toContain('robot_reset');
  });

  it('returns null for a missing ticket', () => {
    expect(resetRobotRuns(db, 9999, 'reset')).toBeNull();
  });

  /**
   * PD-606. `queued` is a Queue state; off the Queue there is no run to re-arm.
   *
   * This wrote `'queued'` unconditionally, so resetting a Backlog ticket armed it — leaving a
   * Backlog card that reported a live run and inflating the nav's fleet counts with work that did
   * not exist. PD-464 got there exactly this way.
   */
  describe('off the Queue, reset clears rather than arms', () => {
    function seedParkedInBacklog(db: Database.Database): number {
      const p = getProjectBySlug(db, 'personal-dashboard');
      if (!p) throw new Error('no PD project');
      const t = createTicket(db, { title: 'dragged back out', projectId: p.id });
      db.prepare(
        "UPDATE agent_tickets SET status = 'backlog', assignee = 'robot', agent_state = 'stuck' WHERE id = ?",
      ).run(t.id);
      return t.id;
    }

    it('clears the agent state on a backlog ticket', () => {
      for (const kind of ['reset', 'unstick'] as const) {
        const id = seedParkedInBacklog(db);
        expect(resetRobotRuns(db, id, kind)?.agentState).toBeNull();
      }
    });

    it('still logs the event, so the remediation is on the record either way', () => {
      const id = seedParkedInBacklog(db);
      resetRobotRuns(db, id, 'reset');
      expect(listTicketEvents(db, id).map((e) => e.type)).toContain('robot_reset');
    });

    it('leaves the Queue behaviour alone', () => {
      const id = seedStuck(db);
      expect(resetRobotRuns(db, id, 'reset')?.agentState).toBe('queued');
    });
  });
});

describe('checkpoint remediation (D-094, PD-737)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    // The worker owns agent_runs; create a minimal version so the Continue can read the WIP ref.
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, issue_number INTEGER, branch TEXT,
      status TEXT, wip_ref TEXT, wip_sha TEXT, report TEXT, started_at INTEGER, finished_at INTEGER
    );`);
  });

  function seedCheckpoint(db: Database.Database): number {
    const p = getProjectBySlug(db, 'personal-dashboard');
    if (!p) throw new Error('no PD project');
    const t = createTicket(db, { title: 'ceiling', projectId: p.id });
    db.prepare("UPDATE agent_tickets SET status = 'queue', assignee = 'robot', agent_state = 'checkpoint' WHERE id = ?").run(t.id);
    db.prepare(
      `INSERT INTO agent_runs (ticket_id, branch, status, wip_ref, wip_sha, report, started_at, finished_at)
       VALUES (?, 'robot/t1', 'checkpoint', 'robot-wip/t1', 'abc', 'the report', 100, 200)`,
    ).run(t.id);
    return t.id;
  }

  const latest = (db: Database.Database, id: number, type: string): RobotEventDetail =>
    (listTicketEvents(db, id).filter((e) => e.type === type).at(-1)?.detail ?? {}) as RobotEventDetail;

  it('Continue re-queues and writes a robot_continue carrying the ceiling, report and WIP ref', () => {
    const id = seedCheckpoint(db);
    const result = continueCheckpoint(db, id, 80);
    expect(result.ok).toBe(true);
    expect(getTicket(db, id)?.agentState).toBe('queued');
    const d = latest(db, id, ROBOT_EVENT.continue);
    expect(d).toMatchObject({ extraTurns: 80, fromWip: true, report: 'the report', wipRef: 'robot-wip/t1' });
  });

  it('Continue defaults to +50 turns when none is given', () => {
    const id = seedCheckpoint(db);
    continueCheckpoint(db, id, undefined);
    expect(latest(db, id, ROBOT_EVENT.continue).extraTurns).toBe(50);
  });

  it('Continue rejects extraTurns above the limit (not clamped)', () => {
    const id = seedCheckpoint(db);
    const result = continueCheckpoint(db, id, 201);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_turns');
    // The ticket was not re-queued and nothing was written.
    expect(getTicket(db, id)?.agentState).toBe('checkpoint');
    expect(listTicketEvents(db, id).some((e) => e.type === ROBOT_EVENT.continue)).toBe(false);
  });

  it('Restart re-queues and writes a robot_restart (keeping the WIP ref)', () => {
    const id = seedCheckpoint(db);
    const result = restartCheckpoint(db, id);
    expect(result.ok).toBe(true);
    expect(getTicket(db, id)?.agentState).toBe('queued');
    expect(listTicketEvents(db, id).some((e) => e.type === ROBOT_EVENT.restart)).toBe(true);
    // Restart keeps the WIP ref — the checkpoint run row is untouched.
    const run = db.prepare("SELECT wip_ref AS w FROM agent_runs WHERE ticket_id = ?").get(id) as { w: string };
    expect(run.w).toBe('robot-wip/t1');
  });

  it('both refuse a ticket that is not at a checkpoint', () => {
    const p = getProjectBySlug(db, 'personal-dashboard')!;
    const t = createTicket(db, { title: 'plain', projectId: p.id });
    db.prepare("UPDATE agent_tickets SET status = 'queue', assignee = 'robot', agent_state = 'working' WHERE id = ?").run(t.id);
    expect(continueCheckpoint(db, t.id, 50).reason).toBe('not_checkpoint');
    expect(restartCheckpoint(db, t.id).reason).toBe('not_checkpoint');
  });

  it('both return not_found for a missing ticket', () => {
    expect(continueCheckpoint(db, 9999, 50).reason).toBe('not_found');
    expect(restartCheckpoint(db, 9999).reason).toBe('not_found');
  });
});

describe('setDispatchPaused (C4 pause/resume)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('pauses with a human reason, then resumes', () => {
    expect(getDispatchPauseState(db).paused).toBe(false);
    const paused = setDispatchPaused(db, true, 'paused by human', 1234);
    expect(paused).toEqual({ paused: true, reason: 'paused by human', since: 1234 });
    const resumed = setDispatchPaused(db, false, null, 2000);
    expect(resumed.paused).toBe(false);
    expect(getDispatchPauseState(db).paused).toBe(false);
  });

  it('a human pause overwrites unconditionally (unlike the worker auto-pause)', () => {
    setDispatchPaused(db, true, 'first', 1000);
    setDispatchPaused(db, true, 'second', 2000);
    expect(getDispatchPauseState(db)).toEqual({ paused: true, reason: 'second', since: 2000 });
  });
});
