import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { listRunsForTicket } from './runs-store';

// Mirror the worker-owned agent_runs schema (apps/agent-worker/.../robot/runs.ts) so the server
// read path can be exercised without booting the worker.
function dbWithRuns(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, issue_number INTEGER,
      branch TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, pr_url TEXT, error TEXT,
      fault_tier TEXT, fault_signature TEXT, fault_reason TEXT, turns INTEGER, tokens INTEGER,
      started_at INTEGER NOT NULL, finished_at INTEGER
    );`);
  return db;
}

describe('listRunsForTicket (server read side)', () => {
  it('returns [] when the table does not exist (worker never ran)', () => {
    expect(listRunsForTicket(new Database(':memory:'), 1)).toEqual([]);
  });

  it('maps rows to camelCase AgentRun, newest first, only for the ticket', () => {
    const db = dbWithRuns();
    const ins = db.prepare(
      `INSERT INTO agent_runs
        (ticket_id, issue_number, branch, status, session_id, pr_url, error,
         fault_tier, fault_signature, fault_reason, turns, tokens, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    ins.run(1, 220, 'robot/220', 'error', 's1', null, 'boom', 'transient', 'boom', 'transient fault: boom', 4, 1200, 1000, 1500);
    ins.run(1, 220, 'robot/220', 'handed-off', 's2', 'https://pr/2', null, null, null, null, 9, 3400, 2000, 2600);
    ins.run(2, 9, 'robot/9', 'no-verify', 's3', null, null, 'transient', 'no-verify', 'no green verify', 3, 800, 500, 900);

    const runs = listRunsForTicket(db, 1);
    expect(runs.map((r) => r.status)).toEqual(['handed-off', 'error']); // newest first
    expect(runs[0]).toMatchObject({
      ticketId: 1,
      status: 'handed-off',
      prUrl: 'https://pr/2',
      turns: 9,
      tokens: 3400,
    });
    expect(runs[1]).toMatchObject({ status: 'error', faultTier: 'transient', faultReason: 'transient fault: boom' });
  });
});
