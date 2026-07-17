import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig } from '../../shared/config';
import type { FaultPolicy } from './faults';
import { reconcileStalledRuns } from './stall';
import { ensureRunsTable, startRun, finishRun, listRunsForTicket } from './runs';

const POLICY: FaultPolicy = { retryCap: 3, promoteAfter: 2, backoffBaseMs: 0, backoffMaxMs: 0 };

function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  ensureRunsTable(d);
  return d;
}
function working(d: Database.Database, id: number): void {
  d.prepare("INSERT INTO agent_tickets (id, status, assignee, agent_state) VALUES (?, 'queue', 'robot', 'working')").run(id);
}
function state(d: Database.Database, id: number): string | null {
  return (d.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = ?').get(id) as { s: string | null }).s;
}
const cfg = (over: Record<string, string> = {}) => loadConfig({ ROBOT_STALL_THRESHOLD_MS: '1000', ...over });

describe('reconcileStalledRuns', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
  });

  it('closes an orphaned running run and re-queues the ticket (transient)', () => {
    working(d, 1);
    startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 10); // started long before the cutoff
    const parked = reconcileStalledRuns(d, cfg(), POLICY, 100_000);
    expect(parked).toBe(0);
    expect(state(d, 1)).toBe('queued');
    const [run] = listRunsForTicket(d, 1);
    expect(run.status).toBe('error');
    expect(run.faultReason).toMatch(/stalled/);
    const types = (d.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1').all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain('robot_stalled');
  });

  it('parks stuck + notifies when the stall exhausts the retry budget', () => {
    working(d, 1);
    startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 10);
    const parked = reconcileStalledRuns(d, cfg({ ROBOT_RETRY_CAP: '1' }), { ...POLICY, retryCap: 1 }, 100_000);
    expect(parked).toBe(1);
    expect(state(d, 1)).toBe('stuck');
    const note = d.prepare("SELECT kind FROM agent_notifications WHERE ticket_id = 1").get() as { kind: string } | undefined;
    expect(note?.kind).toBe('agent_needs_human');
  });

  it('ignores a fresh running run (within the threshold) and a finished run', () => {
    working(d, 1);
    startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 99_900); // started just now → not stalled
    working(d, 2);
    finishRun(d, startRun(d, { ticketId: 2, issueNumber: 2, branch: 'robot/2' }, 10), { status: 'handed-off' }, 50);
    reconcileStalledRuns(d, cfg(), POLICY, 100_000);
    expect(state(d, 1)).toBe('working'); // untouched
    expect(state(d, 2)).toBe('working'); // its run already finished, not an orphan
  });
});
