import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AutoQueuePromotionDetail } from '@dashboard/shared';
import { AUTO_QUEUE_EVENT } from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import { bootstrapMaintenanceHoldsSchema } from '../../lib/maintenance-holds';
import {
  createTicket,
  getProjectBySlug,
  getTicket,
  listNotifications,
  listTicketEvents,
  getAutoQueueTickSummary,
} from './store';

// D-103 (PD-811): the server-side auto-queue promoter. The pure eligibility predicate + capacity
// snapshot are tested in auto-queue.spec.ts; this covers the tick that actually promotes.

// Mock the guard module so one test can force a refusal (eligibility is strictly stricter than the
// Queue gate, so a refusal is otherwise unreachable); every other call delegates to the real guard.
vi.mock('./ticket-guards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ticket-guards')>();
  return { ...actual, queueGuardFailure: vi.fn(actual.queueGuardFailure) };
});
import { queueGuardFailure } from './ticket-guards';
import { runAutoQueueTick } from './auto-queue-promoter';

const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  bootstrapMaintenanceHoldsSchema(db);
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no project');
  db.prepare("UPDATE agent_projects SET robot_enabled = 1, github_repo = 'o/r' WHERE id = ?").run(p.id);
  db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  return { db, pid: p.id };
}

function set(db: Database.Database, id: number, cols: Record<string, unknown>) {
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE agent_tickets SET ${k} = ? WHERE id = ?`).run(v, id);
}

/** A refined, queued (active) Epic with `n` refined, Ready, robot-assigned Backlog members. */
function activeEpic(db: Database.Database, pid: number, n: number) {
  const e = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
  const ids = Array.from({ length: n }, (_, i) => {
    const t = createTicket(db, { title: `m${i}`, body: READY_BODY, projectId: pid, epicId: e.id, assignee: 'robot' });
    set(db, t.id, { refined: 1 });
    return t.id;
  });
  set(db, e.id, { refined: 1, refine_stale: 0, status: 'queue' });
  return { epicId: e.id, ids };
}

function heartbeat(db: Database.Database, at = Date.now()) {
  db.prepare(
    `INSERT INTO worker_heartbeat (worker, started_at, last_seen) VALUES ('agent-worker', ?, ?)
     ON CONFLICT(worker) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(at, at);
}

function statusOf(db: Database.Database, id: number) {
  return getTicket(db, id)?.status;
}
function eventTypes(db: Database.Database, id: number) {
  return listTicketEvents(db, id).map((e) => e.type);
}

let prevMode: string | undefined;
beforeEach(() => {
  prevMode = process.env.AUTO_QUEUE;
  vi.mocked(queueGuardFailure).mockClear();
});
afterEach(() => {
  if (prevMode === undefined) delete process.env.AUTO_QUEUE;
  else process.env.AUTO_QUEUE = prevMode;
});

describe('runAutoQueueTick — mode (D-103 §4)', () => {
  it('off: promotes nothing and writes no status change, but records the tick', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 2);
    process.env.AUTO_QUEUE = 'off';
    const s = runAutoQueueTick(db);
    expect(s.mode).toBe('off');
    expect(s.promoted).toEqual([]);
    expect(ids.map((id) => statusOf(db, id))).toEqual(['backlog', 'backlog']);
    expect(eventTypes(db, ids[0])).not.toContain(AUTO_QUEUE_EVENT.queued);
    expect(getAutoQueueTickSummary(db)?.mode).toBe('off');
  });

  it('dry-run: records would-queue events but never changes ticket status, and raises no notification', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 1);
    process.env.AUTO_QUEUE = 'dry-run';
    const s = runAutoQueueTick(db);
    expect(s.mode).toBe('dry-run');
    expect(s.wouldPromote.map((p) => p.ticketId)).toEqual([ids[0]]);
    expect(s.promoted).toEqual([]);
    expect(statusOf(db, ids[0])).toBe('backlog'); // the write is the one thing dry-run skips
    expect(eventTypes(db, ids[0])).toContain(AUTO_QUEUE_EVENT.dryRun);
    expect(eventTypes(db, ids[0])).not.toContain(AUTO_QUEUE_EVENT.queued);
    expect(listNotifications(db).some((n) => n.kind === 'agent_auto_queued')).toBe(false);
  });

  it('on: promotes eligible tickets, records an audit event with criteria + capacity, flags the card, digests once', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { epicId, ids } = activeEpic(db, pid, 1);
    // A human-assigned sibling in the same Epic: refined so members-refined still holds, but never promoted.
    const extra = createTicket(db, { title: 'steve', body: READY_BODY, projectId: pid, epicId, assignee: 'steve' });
    set(db, extra.id, { refined: 1 });
    set(db, epicId, { refined: 1, refine_stale: 0 }); // adding a member invalidates the Epic (D-089 §6); re-settle it

    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.mode).toBe('on');
    expect(s.promoted.map((p) => p.ticketId)).toEqual([ids[0]]);
    expect(statusOf(db, ids[0])).toBe('queue');
    expect(statusOf(db, extra.id)).toBe('backlog'); // steve-assigned: never promoted

    const queued = listTicketEvents(db, ids[0]).find((e) => e.type === AUTO_QUEUE_EVENT.queued)!;
    expect(queued).toBeTruthy();
    const detail = queued.detail as AutoQueuePromotionDetail;
    expect(detail.criteria.length).toBeGreaterThan(0);
    expect(detail.criteria.every((c) => c.met)).toBe(true);
    expect(detail.capacity.map((r) => r.id)).toEqual(['queue-depth', 'review-wip', 'epic-in-flight', 'worker-healthy']);

    // The card badge is server-derived from the event.
    expect(getTicket(db, ids[0])?.autoQueued).toBe(true);

    // One digest per tick that promoted, not one per ticket.
    const digests = listNotifications(db).filter((n) => n.kind === 'agent_auto_queued');
    expect(digests).toHaveLength(1);
    expect(digests[0].ticketId).toBeNull();
  });

  it('on: never touches assignee, readyBypassed or refined', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 1);
    const before = getTicket(db, ids[0])!;
    process.env.AUTO_QUEUE = 'on';
    runAutoQueueTick(db);
    const after = getTicket(db, ids[0])!;
    expect(after.assignee).toBe(before.assignee);
    expect(after.readyBypassed).toBe(before.readyBypassed);
    expect(after.refined).toBe(before.refined);
  });
});

describe('runAutoQueueTick — eligibility filtering (D-103 §3)', () => {
  it('an excluded Epic’s members are never promoted', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { epicId, ids } = activeEpic(db, pid, 2);
    set(db, epicId, { auto_queue_excluded: 1 });
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.promoted).toEqual([]);
    expect(ids.map((id) => statusOf(db, id))).toEqual(['backlog', 'backlog']);
  });

  it('a steve-assigned ticket is never promoted', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 1);
    set(db, ids[0], { assignee: 'steve' });
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.promoted).toEqual([]);
    expect(statusOf(db, ids[0])).toBe('backlog');
  });

  it('an unrefined member’s Epic (members-refined unmet) promotes nothing', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 2);
    set(db, ids[1], { refined: 0 }); // one open member unrefined ⇒ no member eligible
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.promoted).toEqual([]);
  });
});

describe('runAutoQueueTick — capacity throttling (D-103 §4)', () => {
  it('queue-depth stops the tick at ROBOT_CONCURRENCY × 2 (default 2)', () => {
    const { db, pid } = setup();
    heartbeat(db);
    // Three eligible members across three Epics, so epic-in-flight (1/Epic) never throttles first.
    const e1 = activeEpic(db, pid, 1);
    const e2 = activeEpic(db, pid, 1);
    const e3 = activeEpic(db, pid, 1);
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.stoppedBy).toBe('queue-depth');
    expect(s.promoted).toHaveLength(2);
    const promoted = new Set(s.promoted.map((p) => p.ticketId));
    const queued = [e1, e2, e3].filter((e) => promoted.has(e.ids[0]));
    expect(queued).toHaveLength(2);
    // The third stays in Backlog.
    const inBacklog = [e1, e2, e3].filter((e) => statusOf(db, e.ids[0]) === 'backlog');
    expect(inBacklog).toHaveLength(1);
  });

  it('review-wip stops the tick at 3 robot PRs in review', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const review = activeEpic(db, pid, 3);
    for (const id of review.ids) set(db, id, { status: 'queue', agent_state: 'in-review' });
    const candidate = activeEpic(db, pid, 1); // separate Epic, eligible
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.stoppedBy).toBe('review-wip');
    expect(s.promoted).toEqual([]);
    expect(statusOf(db, candidate.ids[0])).toBe('backlog');
  });

  it('one-in-flight-per-Epic holds across a single tick', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 3); // three eligible members in ONE Epic
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.promoted).toHaveLength(1); // only one member of the Epic promoted this tick
    expect(statusOf(db, ids[0])).toBe('queue');
    expect(statusOf(db, ids[1])).toBe('backlog');
    expect(statusOf(db, ids[2])).toBe('backlog');
  });

  it('dry-run simulates capacity too — would-promote obeys one-in-flight-per-Epic', () => {
    const { db, pid } = setup();
    heartbeat(db);
    activeEpic(db, pid, 3);
    process.env.AUTO_QUEUE = 'dry-run';
    const s = runAutoQueueTick(db);
    expect(s.wouldPromote).toHaveLength(1);
  });
});

describe('runAutoQueueTick — worker health (D-103 §4, §5)', () => {
  it('a paused worker stops promotion before any write', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 1);
    db.prepare("INSERT INTO robot_state (key, value, updated_at) VALUES ('dispatch_paused', 'paused', ?)").run(Date.now());
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.workerHealthy).toBe(false);
    expect(s.stoppedBy).toBe('worker-healthy');
    expect(s.promoted).toEqual([]);
    expect(statusOf(db, ids[0])).toBe('backlog');
  });

  it('a stale heartbeat (worker not confirmed healthy) stops promotion', () => {
    const { db, pid } = setup();
    // no heartbeat ⇒ unhealthy
    const { ids } = activeEpic(db, pid, 1);
    process.env.AUTO_QUEUE = 'on';
    const s = runAutoQueueTick(db);
    expect(s.workerHealthy).toBe(false);
    expect(s.promoted).toEqual([]);
    expect(statusOf(db, ids[0])).toBe('backlog');
  });
});

describe('runAutoQueueTick — guard refusal is logged, not thrown (D-103 §4)', () => {
  it('records auto_queue_refused and keeps going when the Queue guard refuses', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 1);
    vi.mocked(queueGuardFailure).mockReturnValueOnce({
      code: 'QUEUE_GATE',
      message: 'forced refusal',
      blockers: [],
    });
    process.env.AUTO_QUEUE = 'on';
    expect(() => runAutoQueueTick(db)).not.toThrow();
    expect(statusOf(db, ids[0])).toBe('backlog'); // refused ⇒ not promoted
    expect(eventTypes(db, ids[0])).toContain(AUTO_QUEUE_EVENT.refused);
    expect(eventTypes(db, ids[0])).not.toContain(AUTO_QUEUE_EVENT.queued);
  });
});
