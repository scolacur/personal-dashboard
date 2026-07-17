import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  createTicket,
  getDispatchPauseState,
  getProjectBySlug,
  getTicket,
  listTicketEvents,
  resetRobotRuns,
  setDispatchPaused,
} from './store';

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
  db.prepare("UPDATE agent_tickets SET status = 'robot_queue', agent_state = 'stuck' WHERE id = ?").run(t.id);
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
