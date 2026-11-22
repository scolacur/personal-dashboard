import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig, type AgentWorkerConfig } from './shared/config';
import { ensureRunsTable } from './jobs/robot/runs';
import { activeDeployHold, activeMaintenanceHold, ensureRobotStateTable, takeDeployHold, takeMaintenanceHold } from './jobs/robot/state';
import { EX_TEMPFAIL, releaseDeployHoldOnStartup, runDeployDrain } from './deploy-hold';

const NOW = 1_000_000;
const config: AgentWorkerConfig = loadConfig({} as NodeJS.ProcessEnv);
const STALL = config.robot.stallThresholdMs;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal board + runs schema the drain reads (inFlightRunCount joins agent_runs → agent_tickets).
  db.exec(`
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queue',
      agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureRunsTable(db);
  ensureRobotStateTable(db);
  return db;
}

/** A ticket `working` with a `running` run — exactly what `inFlightRunCount` counts (D-055). */
function addInFlight(db: Database.Database, ticketId: number): void {
  db.prepare("INSERT INTO agent_tickets (id, agent_state) VALUES (?, 'working')").run(ticketId);
  db.prepare(
    "INSERT INTO agent_runs (ticket_id, branch, status, started_at) VALUES (?, ?, 'running', ?)",
  ).run(ticketId, `robot/t${ticketId}`, NOW);
}

describe('deploy drain (PD-802, D-105)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('exits 75 (EX_TEMPFAIL) when a run is in flight, and still takes the hold', () => {
    addInFlight(db, 42);
    expect(runDeployDrain(db, config, NOW)).toBe(EX_TEMPFAIL);
    const hold = activeDeployHold(db, NOW);
    expect(hold).not.toBeNull();
    expect(hold?.until).toBe(NOW + STALL); // bounded by the stall threshold
  });

  it('exits 0 when no run is in flight, and takes the hold so nothing new dispatches during the swap', () => {
    expect(runDeployDrain(db, config, NOW)).toBe(0);
    const hold = activeDeployHold(db, NOW);
    expect(hold).not.toBeNull();
    expect(hold?.until).toBe(NOW + STALL);
  });

  it('does not count a stale `running` run whose ticket is no longer working', () => {
    // The production row from the in-flight.ts note: a `running` row left behind a completed ticket.
    db.prepare("INSERT INTO agent_tickets (id, agent_state) VALUES (99, NULL)").run();
    db.prepare("INSERT INTO agent_runs (ticket_id, branch, status, started_at) VALUES (99, 'robot/t99', 'running', ?)").run(NOW);
    expect(runDeployDrain(db, config, NOW)).toBe(0);
  });

  it('the hold it takes gates dispatch until it lapses on its own', () => {
    runDeployDrain(db, config, NOW);
    expect(activeDeployHold(db, NOW + STALL - 1)).not.toBeNull();
    expect(activeDeployHold(db, NOW + STALL)).toBeNull(); // self-clears at the deadline
  });
});

describe('releaseDeployHoldOnStartup (PD-802, D-105)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('releases a leftover deploy hold so dispatch resumes after the recreate', () => {
    takeDeployHold(db, NOW + STALL, 'agent-worker deploy drain', NOW);
    releaseDeployHoldOnStartup(db, NOW + 1);
    expect(activeDeployHold(db, NOW + 2)).toBeNull();
  });

  it("leaves a human's manual maintenance window alone", () => {
    takeMaintenanceHold(db, NOW + STALL, 'manual window', NOW);
    takeDeployHold(db, NOW + STALL, 'agent-worker deploy drain', NOW);
    releaseDeployHoldOnStartup(db, NOW + 1);
    expect(activeDeployHold(db, NOW + 2)).toBeNull();
    expect(activeMaintenanceHold(db, NOW + 2)?.reason).toBe('manual window');
  });

  it('is a no-op when no hold is set', () => {
    expect(() => releaseDeployHoldOnStartup(db, NOW)).not.toThrow();
    expect(activeDeployHold(db, NOW)).toBeNull();
  });
});
