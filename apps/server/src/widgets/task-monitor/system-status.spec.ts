import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  createTicket,
  getDispatchPauseState,
  getProjectBySlug,
  getSessionLimitHold,
  getSortieFleet,
  listWorkerHeartbeats,
} from './store';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function pdId(db: Database.Database): number {
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no PD project');
  return p.id;
}

/** Seed a ticket in a given Robot loop agent_state (the loop normally sets this). */
function seedTicket(db: Database.Database, title: string, agentState: string | null): number {
  const t = createTicket(db, { title, projectId: pdId(db) });
  if (agentState !== null) {
    db.prepare('UPDATE agent_tickets SET agent_state = ? WHERE id = ?').run(agentState, t.id);
  }
  return t.id;
}

describe('getSortieFleet', () => {
  it('counts active tickets by agent_state, omitting null/zero states', () => {
    const db = freshDb();
    seedTicket(db, 'a', 'working');
    seedTicket(db, 'b', 'working');
    seedTicket(db, 'c', 'stuck');
    seedTicket(db, 'd', null); // manual ticket — no agent state
    expect(getSortieFleet(db)).toEqual({ working: 2, stuck: 1 });
  });

  it('excludes archived tickets', () => {
    const db = freshDb();
    const id = seedTicket(db, 'a', 'working');
    seedTicket(db, 'b', 'working');
    db.prepare('UPDATE agent_tickets SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    expect(getSortieFleet(db)).toEqual({ working: 1 });
  });

  it('returns an empty map when nothing has an agent state', () => {
    const db = freshDb();
    seedTicket(db, 'a', null);
    expect(getSortieFleet(db)).toEqual({});
  });
});

describe('listWorkerHeartbeats', () => {
  it('maps rows to camelCase, freshest first', () => {
    const db = freshDb();
    const ins = db.prepare(
      `INSERT INTO worker_heartbeat (worker, started_at, last_seen, pid, sha, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ins.run('agent-worker', 1000, 5000, 42, 'abc123', 'claude-opus-4-8');
    ins.run('other-worker', 1000, 9000, 7, null, null);

    const hbs = listWorkerHeartbeats(db);
    expect(hbs.map((h) => h.worker)).toEqual(['other-worker', 'agent-worker']);
    expect(hbs[1]).toEqual({
      worker: 'agent-worker',
      startedAt: 1000,
      lastSeen: 5000,
      pid: 42,
      sha: 'abc123',
      model: 'claude-opus-4-8',
    });
  });

  it('is empty before any worker has beaten', () => {
    expect(listWorkerHeartbeats(freshDb())).toEqual([]);
  });
});

describe('getDispatchPauseState', () => {
  // robot_state is worker-owned; mirror the worker's create so the server can read it.
  function withRobotState(db: Database.Database): void {
    db.exec('CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  }

  it('reports running when the robot_state table does not exist yet', () => {
    expect(getDispatchPauseState(freshDb())).toEqual({ paused: false, reason: null, since: null });
  });

  it('reports running when the flag row is absent or cleared (null value)', () => {
    const db = freshDb();
    withRobotState(db);
    expect(getDispatchPauseState(db)).toEqual({ paused: false, reason: null, since: null });
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)').run('dispatch_paused', 5);
    expect(getDispatchPauseState(db)).toEqual({ paused: false, reason: null, since: null });
  });

  it('reports paused with reason + since when the flag is set', () => {
    const db = freshDb();
    withRobotState(db);
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'dispatch_paused',
      'auth/credit fault (loop-wide): HTTP 403',
      1700,
    );
    expect(getDispatchPauseState(db)).toEqual({
      paused: true,
      reason: 'auth/credit fault (loop-wide): HTTP 403',
      since: 1700,
    });
  });
});

describe('getSessionLimitHold (PD-470)', () => {
  function withHold(db: Database.Database, until: number, reason = 'provider session limit'): void {
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'session_limit_until',
      JSON.stringify({ until, reason }),
      1000,
    );
  }

  it('reads null when the worker has never booted (no robot_state table)', () => {
    expect(getSessionLimitHold(freshDb())).toBeNull();
  });

  it('reports an in-force hold with its end time', () => {
    const db = freshDb();
    withHold(db, 9000);
    expect(getSessionLimitHold(db, 5000)).toEqual({ until: 9000, reason: 'provider session limit', since: 1000 });
  });

  // The row survives until the worker's next cycle clears it, so the READ has to expire it too —
  // showing "waiting until 5:30" after 5:30 would be a lie the UI has no way to catch.
  it('reports an expired hold as no hold at all', () => {
    const db = freshDb();
    withHold(db, 9000);
    expect(getSessionLimitHold(db, 9000)).toBeNull();
    expect(getSessionLimitHold(db, 12_000)).toBeNull();
  });

  it('survives a corrupt row rather than breaking the status endpoint', () => {
    const db = freshDb();
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run('session_limit_until', '{oops', 1000);
    expect(getSessionLimitHold(db, 5000)).toBeNull();
  });
});
