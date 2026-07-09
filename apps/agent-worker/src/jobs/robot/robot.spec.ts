import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { processRobotQueue, branchFor, SIMPLE_RETRY_CAP, type RobotDeps } from './robot';
import { startRun, finishRun, listRunsForTicket, ensureRunsTable } from './runs';
import type { RobotSessionResult } from './session';

const READY = ['## Context', 'c', '## Task', 't', '## Done When', 'd', '## Out of scope', 'o'].join('\n');

function boardDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, github_repo TEXT, sortie_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL,
      project_id INTEGER, github_issue_number INTEGER, agent_state TEXT, archived_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_ticket_relations (id INTEGER PRIMARY KEY, from_ticket_id INTEGER, to_ticket_id INTEGER, type TEXT);
  `);
  db.prepare('INSERT INTO agent_projects (id, github_repo, sortie_enabled) VALUES (1, ?, 1)').run('scolacur/personal-dashboard');
  ensureRunsTable(db);
  return db;
}

function addQueued(db: Database.Database, id: number, issue: number | null = id): void {
  db.prepare(
    `INSERT INTO agent_tickets (id, title, body, status, project_id, github_issue_number, agent_state)
     VALUES (?, ?, ?, 'robot_queue', 1, ?, NULL)`,
  ).run(id, `T${id}`, READY, issue);
}

function agentState(db: Database.Database, id: number): string | null {
  return (db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = ?').get(id) as { s: string | null }).s;
}

const cfg = (over: Record<string, string> = {}): AgentWorkerConfig =>
  loadConfig({ ROBOT_DISPATCH_ENABLED: '1', ROBOT_ALLOWLIST: '1', ...over });

/** Deps that succeed with a full hand-off, unless a custom session result is given. */
function deps(sessionResult?: Partial<RobotSessionResult>): RobotDeps {
  return {
    ensureWorktree: async (_c, branch) => ({ dir: `/wt/${branch.replace('/', '-')}`, branch }),
    removeWorktree: async () => {},
    runSession: async () => ({ ok: true, sessionId: 'sess-1', verifyOk: true, prNumber: 314, ...sessionResult }),
    now: () => 1000,
  };
}

describe('processRobotQueue', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = boardDb();
  });

  it('branchFor uses the issue number, or t<id> when unlinked', () => {
    expect(branchFor({ id: 5, issueNumber: 220, repo: 'r', title: 't', body: null })).toBe('robot/220');
    expect(branchFor({ id: 5, issueNumber: null, repo: 'r', title: 't', body: null })).toBe('robot/t5');
  });

  it('does nothing when dispatch is disabled', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg({ ROBOT_DISPATCH_ENABLED: '0' }), deps());
    expect(n).toBe(0);
    expect(listRunsForTicket(db, 1)).toEqual([]);
  });

  it('fails closed when the DB-perms precondition is not met (uid configured, db absent)', async () => {
    addQueued(db, 1);
    // codingUid set forces the check; dbPathFor points at a nonexistent file ⇒ stat fails ⇒ not ok.
    const n = await processRobotQueue(db, cfg({ ROBOT_CODING_UID: '1500', DATA_DIR: '/nonexistent-xyz' }), deps());
    expect(n).toBe(0);
    expect(listRunsForTicket(db, 1)).toEqual([]);
    expect(agentState(db, 1)).toBeNull(); // never touched
  });

  it('happy path: worktree → session → verify-ok + PR → run handed-off + state in-review', async () => {
    addQueued(db, 1, 220);
    const n = await processRobotQueue(db, cfg(), deps());
    expect(n).toBe(1);
    expect(agentState(db, 1)).toBe('in-review');
    const [run] = listRunsForTicket(db, 1);
    expect(run).toMatchObject({
      status: 'handed-off',
      branch: 'robot/220',
      sessionId: 'sess-1',
      prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314',
    });
  });

  it('no verify-ok ⇒ run no-verify + re-queued for retry (D-046 gate, no red PR)', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg(), deps({ ok: true, verifyOk: false, prNumber: undefined }));
    expect(n).toBe(0);
    expect(agentState(db, 1)).toBe('queued');
    expect(listRunsForTicket(db, 1)[0].status).toBe('no-verify');
  });

  it('session error ⇒ run error + re-queued', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg(), deps({ ok: false, verifyOk: false, error: 'max turns' }));
    expect(n).toBe(0);
    expect(agentState(db, 1)).toBe('queued');
    const [run] = listRunsForTicket(db, 1);
    expect(run.status).toBe('error');
    expect(run.error).toBe('max turns');
  });

  it('parks a ticket at the retry cap instead of dispatching again', async () => {
    addQueued(db, 1);
    // Pre-load SIMPLE_RETRY_CAP finished runs.
    for (let i = 0; i < SIMPLE_RETRY_CAP; i++) {
      finishRun(db, startRun(db, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }), { status: 'error' });
    }
    let sessionRan = false;
    const d = deps();
    d.runSession = async () => {
      sessionRan = true;
      return { ok: true, verifyOk: true, prNumber: 1 };
    };
    const n = await processRobotQueue(db, cfg(), d);
    expect(n).toBe(0);
    expect(sessionRan).toBe(false);
    expect(agentState(db, 1)).toBe('stuck');
  });

  it('respects the allowlist — an un-allowlisted queued ticket is left alone', async () => {
    addQueued(db, 1);
    addQueued(db, 2);
    const n = await processRobotQueue(db, cfg({ ROBOT_ALLOWLIST: '1' }), deps());
    expect(n).toBe(1);
    expect(agentState(db, 1)).toBe('in-review');
    expect(agentState(db, 2)).toBeNull(); // untouched
    expect(listRunsForTicket(db, 2)).toEqual([]);
  });
});
