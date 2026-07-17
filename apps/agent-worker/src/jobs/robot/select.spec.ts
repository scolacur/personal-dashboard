import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadRobotConfig, type RobotConfig } from '../../shared/config';
import { robotQueueCandidates, selectDispatchable, type RobotCandidate } from './select';

const READY = ['## Context', 'ctx', '## Task', 'do it', '## Done When', 'done', '## Out of scope', 'no'].join('\n');

/** Minimal slice of the board schema the selection query touches. */
function boardDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, github_repo TEXT, robot_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, assignee TEXT,
      ready INTEGER NOT NULL DEFAULT 0, ready_bypassed INTEGER NOT NULL DEFAULT 0,
      project_id INTEGER, github_issue_number INTEGER, agent_state TEXT, archived_at INTEGER
    );
    CREATE TABLE agent_ticket_relations (
      id INTEGER PRIMARY KEY, from_ticket_id INTEGER NOT NULL, to_ticket_id INTEGER NOT NULL, type TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO agent_projects (id, github_repo, robot_enabled) VALUES (1, ?, 1)').run('scolacur/personal-dashboard');
  db.prepare('INSERT INTO agent_projects (id, github_repo, robot_enabled) VALUES (2, ?, 0)').run('scolacur/other'); // robot-disabled
  return db;
}

function addTicket(
  db: Database.Database,
  t: {
    id: number;
    status: string;
    projectId?: number;
    body?: string | null;
    issue?: number | null;
    archived?: boolean;
    agentState?: string | null;
    /** Defaults to 'robot' — the assignee the candidate SQL filters on (D-058). */
    assignee?: string | null;
    /** Persisted readiness flag (D-058). Defaults to 1 so a queue ticket is dispatchable. */
    ready?: 0 | 1;
    /** Persisted ready-bypass flag (D-058). Defaults to 0. */
    readyBypassed?: 0 | 1;
  },
): void {
  db.prepare(
    `INSERT INTO agent_tickets (id, title, body, status, assignee, ready, ready_bypassed, project_id, github_issue_number, agent_state, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    `T${t.id}`,
    t.body ?? READY,
    t.status,
    t.assignee === undefined ? 'robot' : t.assignee,
    t.ready ?? 1,
    t.readyBypassed ?? 0,
    t.projectId ?? 1,
    t.issue ?? null,
    t.agentState ?? null,
    t.archived ? 1 : null,
  );
}

function addBlocks(db: Database.Database, blocker: number, blocked: number): void {
  db.prepare('INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type) VALUES (?, ?, ?)').run(
    blocker,
    blocked,
    'blocks',
  );
}

const robotCfg = (over: Partial<RobotConfig> = {}): RobotConfig => ({ ...loadRobotConfig({}), ...over });

describe('robotQueueCandidates', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = boardDb();
  });

  it('returns only queue tickets assigned to robot in a robot-enabled repo project', () => {
    addTicket(db, { id: 1, status: 'queue', issue: 220 });
    addTicket(db, { id: 2, status: 'prioritized' }); // wrong lane
    addTicket(db, { id: 3, status: 'queue', projectId: 2 }); // robot-disabled project
    const c = robotQueueCandidates(db);
    expect(c.map((x) => x.id)).toEqual([1]);
    expect(c[0]).toMatchObject({ id: 1, issueNumber: 220, repo: 'scolacur/personal-dashboard' });
  });

  it('excludes a queue ticket assigned to steve (not robot) (D-058)', () => {
    addTicket(db, { id: 1, status: 'queue', assignee: 'steve' });
    addTicket(db, { id: 2, status: 'queue', assignee: 'robot' });
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([2]);
  });

  // ---- D-058 ready-gate: readiness is now the persisted ready/ready_bypassed flags, not a body parse ----

  it('excludes a NOT-ready, non-bypassed queue ticket (ready=0, ready_bypassed=0)', () => {
    addTicket(db, { id: 1, status: 'queue', ready: 0, readyBypassed: 0 });
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([]);
  });

  it('includes a ready-bypassed queue ticket even when not ready (ready=0, ready_bypassed=1)', () => {
    addTicket(db, { id: 1, status: 'queue', ready: 0, readyBypassed: 1 });
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([1]);
  });

  it('excludes archived tickets', () => {
    addTicket(db, { id: 1, status: 'queue', archived: true });
    expect(robotQueueCandidates(db)).toEqual([]);
  });

  it('only dispatches fresh tickets (agent_state NULL or queued), not working/handed-off ones', () => {
    addTicket(db, { id: 1, status: 'queue', agentState: null });
    addTicket(db, { id: 2, status: 'queue', agentState: 'queued' });
    addTicket(db, { id: 3, status: 'queue', agentState: 'working' }); // in flight
    addTicket(db, { id: 4, status: 'queue', agentState: 'in-review' }); // handed off
    addTicket(db, { id: 5, status: 'queue', agentState: 'stuck' }); // parked
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([1, 2]);
  });

  it('excludes a ticket blocked by an unresolved blocks relation (D-051)', () => {
    addTicket(db, { id: 10, status: 'prioritized' }); // the blocker, not yet done
    addTicket(db, { id: 11, status: 'queue' }); // blocked by 10
    addBlocks(db, 10, 11);
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([]);
  });

  it('includes a ticket whose blocker is completed/closed', () => {
    addTicket(db, { id: 10, status: 'completed' });
    addTicket(db, { id: 11, status: 'queue' });
    addBlocks(db, 10, 11);
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([11]);
  });

  it('does NOT exclude the blocker itself (direction matters)', () => {
    // 20 blocks 21; 20 is the from/blocker. 20 being in queue is fine — it is not blocked.
    addTicket(db, { id: 20, status: 'queue' });
    addTicket(db, { id: 21, status: 'prioritized' });
    addBlocks(db, 20, 21);
    expect(robotQueueCandidates(db).map((x) => x.id)).toEqual([20]);
  });
});

describe('selectDispatchable', () => {
  const cand = (id: number, body: string | null = READY): RobotCandidate => ({
    id,
    issueNumber: id,
    repo: 'r',
    title: `T${id}`,
    body,
  });

  it('dispatches nothing when disabled', () => {
    expect(selectDispatchable([cand(1)], robotCfg({ dispatchEnabled: false, allowlist: [1] }), 0)).toEqual([]);
  });

  it('dispatches nothing when the scope is "none" (killswitch, C6/PD-347)', () => {
    expect(selectDispatchable([cand(1), cand(2)], robotCfg({ dispatchEnabled: true, allowlist: 'none' }), 0)).toEqual([]);
  });

  it('dispatches all candidates when the scope is "all" (go-live default, C6/PD-347)', () => {
    // D-058: readiness is filtered upstream in robotQueueCandidates' SQL (the persisted ready/
    // ready_bypassed flags), not re-parsed here — selectDispatchable no longer body-parses, so a
    // candidate that reached it is already ready.
    const out = selectDispatchable(
      [cand(1), cand(2), cand(3)],
      robotCfg({ dispatchEnabled: true, allowlist: 'all', concurrency: 5 }),
      0,
    );
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('dispatches only allowlisted candidates when given an id list', () => {
    const out = selectDispatchable(
      [cand(1), cand(2), cand(3)],
      robotCfg({ dispatchEnabled: true, allowlist: [1, 3], concurrency: 5 }),
      0,
    );
    expect(out.map((c) => c.id)).toEqual([1, 3]); // 2 not allowlisted
  });

  it('respects the concurrency cap, accounting for in-flight Robots', () => {
    const cfg = robotCfg({ dispatchEnabled: true, allowlist: [1, 2, 3], concurrency: 2 });
    expect(selectDispatchable([cand(1), cand(2), cand(3)], cfg, 0).map((c) => c.id)).toEqual([1, 2]);
    expect(selectDispatchable([cand(1), cand(2), cand(3)], cfg, 1).map((c) => c.id)).toEqual([1]);
    expect(selectDispatchable([cand(1), cand(2), cand(3)], cfg, 2)).toEqual([]);
  });
});
