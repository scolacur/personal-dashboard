import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig } from '../../shared/config';
import type { FaultPolicy } from './faults';
import { reconcileStalledRuns } from './stall';
import { ensureRunsTable, startRun, finishRun, listRunsForTicket } from './runs';
import { createRunOwnership, type RunOwnership } from './ownership';

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
/** An ownership registry that owns `runId`, started at `startedAt`, last progress at `lastProgressAt`. */
function owning(runId: number, ticketId: number, startedAt: number, lastProgressAt = startedAt): RunOwnership {
  const o = createRunOwnership(startedAt);
  o.begin({ runId, ticketId, branch: `robot/${ticketId}`, abort: new AbortController() }, startedAt);
  o.progress(runId, lastProgressAt);
  return o;
}
const cfg = (over: Record<string, string> = {}) => loadConfig({ ROBOT_STALL_THRESHOLD_MS: '1000', ...over });

describe('reconcileStalledRuns (ownership-based, D-104)', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
  });

  it('reclaims a run the live process does not own immediately — no age wait (process-restart orphan)', () => {
    working(d, 1);
    // Started only 1ms before "now": NOT stale by age, but not owned → a dead-process orphan.
    startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 99_999);
    const parked = reconcileStalledRuns(d, cfg(), POLICY, createRunOwnership(100_000), 100_000);
    expect(parked).toBe(0);
    expect(state(d, 1)).toBe('queued'); // re-queued at once, not left to sit out the 2h threshold
    const [run] = listRunsForTicket(d, 1);
    expect(run.status).toBe('error');
    expect(run.faultSignature).toBe('process-restart-orphan');
    expect(run.faultReason).toMatch(/process restart orphan/);
    const types = (d.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1').all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain('robot_stalled');
  });

  it('never parks a restart orphan, even under an exhausted retry cap (infra faults always re-queue)', () => {
    working(d, 1);
    startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 10);
    // retryCap 1 would park an ordinary transient — but an infra orphan is never counted.
    const parked = reconcileStalledRuns(d, cfg({ ROBOT_RETRY_CAP: '1' }), { ...POLICY, retryCap: 1 }, createRunOwnership(100_000), 100_000);
    expect(parked).toBe(0);
    expect(state(d, 1)).toBe('queued');
  });

  it('does NOT reclaim an owned run that is still making progress, however old', () => {
    working(d, 1);
    const runId = startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 10); // started long ago
    // Owned, and it reported a turn just now (within the threshold of `now`).
    const ownership = owning(runId, 1, 10, 99_500);
    reconcileStalledRuns(d, cfg(), POLICY, ownership, 100_000);
    expect(state(d, 1)).toBe('working'); // left alone — a live run that is progressing
    expect(listRunsForTicket(d, 1)[0].status).toBe('running');
  });

  it('reclaims an owned run whose session has hung (no progress past the threshold) — the backstop', () => {
    working(d, 1);
    const runId = startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 10);
    // Owned, but last progress was long ago (> 1000ms before `now`).
    const ownership = owning(runId, 1, 10, 10);
    const aborted = ownership.get(runId)!.abort;
    reconcileStalledRuns(d, cfg(), POLICY, ownership, 100_000);
    expect(state(d, 1)).toBe('queued'); // reclaimed by the hung-session backstop
    const [run] = listRunsForTicket(d, 1);
    expect(run.status).toBe('error');
    expect(run.faultReason).toMatch(/made no progress/);
    expect(aborted.signal.aborted).toBe(true); // the zombie session was torn down
    expect(ownership.owns(runId)).toBe(false); // and forgotten
  });

  it('measures the hung backstop from the last progress, not started_at', () => {
    working(d, 1);
    const runId = startRun(d, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }, 10); // old start
    // Progressed recently → within threshold → not reclaimed, proving the clock is last-progress.
    const ownership = owning(runId, 1, 10, 99_999);
    reconcileStalledRuns(d, cfg(), POLICY, ownership, 100_000);
    expect(state(d, 1)).toBe('working');
  });

  it('ignores a finished run (its row is terminal, never an orphan)', () => {
    working(d, 2);
    finishRun(d, startRun(d, { ticketId: 2, issueNumber: 2, branch: 'robot/2' }, 10), { status: 'handed-off' }, 50);
    reconcileStalledRuns(d, cfg(), POLICY, createRunOwnership(100_000), 100_000);
    expect(state(d, 2)).toBe('working'); // its run already finished, not an orphan
  });
});
