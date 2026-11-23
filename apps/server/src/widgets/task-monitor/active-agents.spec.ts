import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { createTicket, getProjectBySlug } from './store';
import { getActiveAgents, STALE_RUN_MS } from './active-agents';

const NOW = 1_800_000_000_000;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

/** The worker owns these tables; mirror just the columns the reader touches. */
function addWorkerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, branch TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      turns INTEGER, max_turns INTEGER, tokens INTEGER);
    CREATE TABLE evaluator_runs (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, pr_number INTEGER NOT NULL,
      round INTEGER NOT NULL, turns INTEGER, tokens INTEGER, model TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER);
  `);
}

function seed(db: Database.Database) {
  const project = getProjectBySlug(db, 'personal-dashboard')!;
  db.prepare('UPDATE agent_projects SET color = ? WHERE id = ?').run('#3b82f6', project.id);
  const ticket = createTicket(db, { title: 'Build the robots', projectId: project.id });
  return { project, ticket };
}

describe('getActiveAgents', () => {
  it('reads no agents — and does not throw — when the worker tables do not exist yet', () => {
    expect(getActiveAgents(freshDb(), NOW)).toEqual([]);
  });

  it('returns a live Robot run with its ticket, project colour, live metrics and the heartbeat model', () => {
    const db = freshDb();
    addWorkerTables(db);
    const { project, ticket } = seed(db);
    db.prepare(
      `INSERT INTO worker_heartbeat (worker, started_at, last_seen, model) VALUES ('agent-worker', ?, ?, 'claude-opus-5-5')`,
    ).run(NOW - 1000, NOW);
    db.prepare(
      `INSERT INTO agent_runs (ticket_id, branch, status, started_at, turns, max_turns, tokens)
       VALUES (?, 'b', 'running', ?, 12, 50, 34000)`,
    ).run(ticket.id, NOW - 60_000);
    // finished runs are not tiles
    db.prepare(
      `INSERT INTO agent_runs (ticket_id, branch, status, started_at, finished_at) VALUES (?, 'b', 'succeeded', ?, ?)`,
    ).run(ticket.id, NOW - 120_000, NOW - 90_000);

    const agents = getActiveAgents(db, NOW);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      kind: 'robot',
      ticket: { id: ticket.id, displayId: ticket.displayId, title: 'Build the robots' },
      project: { id: project.id, color: '#3b82f6' },
      turns: 12,
      maxTurns: 50,
      tokens: 34000,
      model: 'claude-opus-5-5',
      detail: null,
    });
  });

  it('returns an in-flight Evaluator with its round and PR, and a running Audit with its scope', () => {
    const db = freshDb();
    addWorkerTables(db);
    const { ticket } = seed(db);
    db.prepare(
      `INSERT INTO evaluator_runs (ticket_id, pr_number, round, model, started_at) VALUES (?, 481, 2, 'claude-opus-4-8', ?)`,
    ).run(ticket.id, NOW - 5000);
    db.prepare(
      `INSERT INTO audit_run (status, scope, model, started_at, created_at, turns, tokens) VALUES ('running', 'single:PD', 'claude-sonnet-5-5', ?, ?, 7, 21000)`,
    ).run(NOW - 5000, NOW - 6000);
    db.prepare(`INSERT INTO audit_run (status, created_at) VALUES ('requested', ?)`).run(NOW);

    const agents = getActiveAgents(db, NOW);
    expect(agents.map((a) => a.kind)).toEqual(['evaluator', 'auditor']);
    expect(agents[0]).toMatchObject({ model: 'claude-opus-4-8', detail: 'round 2 · PR #481', tokens: null });
    // PD-910: the audit's live turns/tokens come through.
    expect(agents[1]).toMatchObject({
      ticket: null,
      project: null,
      model: 'claude-sonnet-5-5',
      detail: 'scope single:PD',
      turns: 7,
      tokens: 21000,
    });
  });

  it('drops a run left "running" past the stale window, so a dead worker cannot leave a ghost robot', () => {
    const db = freshDb();
    addWorkerTables(db);
    const { ticket } = seed(db);
    db.prepare(`INSERT INTO agent_runs (ticket_id, branch, status, started_at) VALUES (?, 'b', 'running', ?)`).run(
      ticket.id,
      NOW - STALE_RUN_MS - 1,
    );
    expect(getActiveAgents(db, NOW)).toEqual([]);
  });
});
