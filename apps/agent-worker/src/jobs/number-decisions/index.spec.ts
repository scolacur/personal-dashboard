import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { inFlightRunCount } from './index';

/**
 * The drain's view of "in flight" (PD-498). These run against a real schema rather than an injected
 * count, because the bug this guards was invisible to every test that injected one.
 */
describe('inFlightRunCount', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, status TEXT, agent_state TEXT);
      CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, ticket_id INTEGER, status TEXT, started_at INTEGER);
    `);
  });

  function ticket(id: number, status: string, agentState: string | null): void {
    db.prepare('INSERT INTO agent_tickets (id, status, agent_state) VALUES (?, ?, ?)').run(id, status, agentState);
  }
  function run(id: number, ticketId: number, status: string): void {
    db.prepare('INSERT INTO agent_runs (id, ticket_id, status, started_at) VALUES (?, ?, ?, 0)').run(id, ticketId, status);
  }

  it('is zero on an empty board', () => {
    expect(inFlightRunCount(db)).toBe(0);
  });

  it('counts a run whose ticket is still working', () => {
    ticket(1, 'queue', 'working');
    run(10, 1, 'running');
    expect(inFlightRunCount(db)).toBe(1);
  });

  it('ignores a finished run', () => {
    ticket(1, 'queue', 'working');
    run(10, 1, 'handed-off');
    expect(inFlightRunCount(db)).toBe(0);
  });

  it('ignores a stuck `running` row whose ticket finished long ago', () => {
    // The real one, from the NAS on 2026-08-22: a run left `running` since 2026-07-16 against a
    // ticket completed five weeks earlier with agent_state NULL. `orphanedRunningRuns` only reaches
    // runs whose ticket is `working`, so nothing ever closes it. Counting it would pin the drain
    // above zero forever and make every cycle time out.
    ticket(467, 'completed', null);
    run(2, 467, 'running');
    expect(inFlightRunCount(db)).toBe(0);
  });

  it('counts only the genuinely live runs when both kinds are present', () => {
    ticket(467, 'completed', null);
    run(2, 467, 'running'); // the orphan
    ticket(500, 'queue', 'working');
    run(11, 500, 'running'); // genuinely in flight
    expect(inFlightRunCount(db)).toBe(1);
  });

  it('ignores a run whose ticket row is gone entirely', () => {
    run(12, 999, 'running');
    expect(inFlightRunCount(db)).toBe(0);
  });
});
