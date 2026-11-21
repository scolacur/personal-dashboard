import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {
  AUTO_QUEUE_CRITERIA,
  ROBOT_CAPACITY_POLICY_KEY,
  autoQueueEligibility,
  autoQueueEpicEligibility,
  autoQueueModeNote,
  autoQueueVerdictLine,
  autoQueueEpicVerdictLine,
  autoQueueMemberRollup,
  parseAutoQueueMode,
  AUTO_QUEUE_VERDICT_SHORT,
  type AutoQueueCriterionId,
  type TicketAssignee,
  type TicketStatus,
  type RefineState,
} from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { createTicket, getProjectBySlug, getTicket, addRelation } from './store';
import { computeAutoQueueCapacity } from './auto-queue';
import { bootstrapMaintenanceHoldsSchema } from '../../lib/maintenance-holds';

// D-103 (PD-808): auto-queue eligibility. The pure predicate lives in packages/shared and is tested
// here, beside queue-blockers.spec.ts, because packages/shared has no test runner of its own.

/* ── The pure predicate ──────────────────────────────────────────────────── */

const ticket = {
  id: 1,
  status: 'backlog' as TicketStatus,
  assignee: 'robot' as TicketAssignee | null,
  refined: true,
  ready: true,
  readyBypassed: false,
  refineState: null as RefineState | null,
  isEpic: false,
};
const epic = { id: 10, refined: true, refineStale: false, status: 'queue' as const, autoQueueExcluded: false };
const project = { robotEnabled: true, githubRepo: 'o/r' };
const allClear = {
  ticket,
  epic,
  members: [
    { id: 1, refined: true, status: 'backlog' as const },
    { id: 2, refined: true, status: 'backlog' as const },
  ],
  openBlockerIds: [] as number[],
  project,
};

type Input = Parameters<typeof autoQueueEligibility>[0];
function unmet(input: Input): AutoQueueCriterionId[] {
  return autoQueueEligibility(input)
    .criteria.filter((c) => !c.met)
    .map((c) => c.id);
}

describe('autoQueueEligibility (D-103)', () => {
  it('returns all eleven criteria, in display order, matching AUTO_QUEUE_CRITERIA, all met → eligible', () => {
    const r = autoQueueEligibility(allClear);
    expect(r.criteria.map((c) => c.id)).toEqual(AUTO_QUEUE_CRITERIA.map((d) => d.id));
    expect(r.criteria.every((c) => c.met && c.reason === undefined)).toBe(true);
    expect(r.verdict).toBe('eligible');
  });

  it('carries each definition’s label and description (one source for checklist + modal)', () => {
    const r = autoQueueEligibility(allClear);
    for (const [i, d] of AUTO_QUEUE_CRITERIA.entries()) {
      expect(r.criteria[i]).toMatchObject({ id: d.id, label: d.label, description: d.description });
    }
  });

  const cases: [AutoQueueCriterionId, Partial<Input>][] = [
    ['refined', { ticket: { ...ticket, refined: false } }],
    ['epic-refined', { epic: { ...epic, refined: false } }],
    ['epic-not-stale', { epic: { ...epic, refineStale: true } }],
    ['members-refined', { members: [...allClear.members, { id: 3, refined: false, status: 'backlog' }] }],
    ['epic-active', { epic: { ...epic, status: 'backlog' } }],
    ['ready', { ticket: { ...ticket, ready: false } }],
    ['unblocked', { openBlockerIds: [99] }],
    ['refine-settled', { ticket: { ...ticket, refineState: 'awaiting-human' } }],
    ['epic-not-excluded', { epic: { ...epic, autoQueueExcluded: true } }],
    ['robot-project', { project: { robotEnabled: false, githubRepo: 'o/r' } }],
  ];
  for (const [id, override] of cases) {
    it(`${id} — unmet alone, with a reason, makes the ticket not-eligible`, () => {
      const input = { ...allClear, ...override } as Input;
      expect(unmet(input)).toEqual([id]);
      const c = autoQueueEligibility(input).criteria.find((x) => x.id === id)!;
      expect(c.reason).toBeTruthy();
      expect(autoQueueEligibility(input).verdict).toBe('not-eligible');
    });
  }

  it('ready — a bypass Steve already set satisfies it', () => {
    expect(unmet({ ...allClear, ticket: { ...ticket, ready: false, readyBypassed: true } })).toEqual([]);
  });

  it('robot-project — a project with no repo fails it; no project at all fails it', () => {
    expect(unmet({ ...allClear, project: { robotEnabled: true, githubRepo: null } })).toEqual(['robot-project']);
    expect(unmet({ ...allClear, project: null })).toEqual(['robot-project']);
  });

  it('no Epic — every Epic-scoped criterion fails, never eligible', () => {
    const r = autoQueueEligibility({ ...allClear, epic: null, members: [] });
    expect(r.verdict).toBe('not-eligible');
    expect(r.criteria.find((c) => c.id === 'epic-active')?.met).toBe(false);
  });

  it('human-work — steve-assigned and unassigned tickets are never auto-queued, even if all else passes', () => {
    expect(autoQueueEligibility({ ...allClear, ticket: { ...ticket, assignee: 'steve' } }).verdict).toBe('human-work');
    expect(autoQueueEligibility({ ...allClear, ticket: { ...ticket, assignee: null } }).verdict).toBe('human-work');
    // …but the criteria still render, with assigned-robot unmet.
    expect(unmet({ ...allClear, ticket: { ...ticket, assignee: 'steve' } })).toEqual(['assigned-robot']);
  });

  it('in-queue and terminal verdicts', () => {
    expect(autoQueueEligibility({ ...allClear, ticket: { ...ticket, status: 'queue' } }).verdict).toBe('in-queue');
    expect(autoQueueEligibility({ ...allClear, ticket: { ...ticket, status: 'completed' } }).verdict).toBe('terminal');
    expect(autoQueueEligibility({ ...allClear, ticket: { ...ticket, status: 'closed', assignee: 'steve' } }).verdict).toBe('terminal');
  });
});

describe('autoQueueEpicEligibility (D-103)', () => {
  const m = (id: number, o: Partial<typeof ticket> = {}) => ({ ...ticket, id, ...o });

  it('returns the five Epic-level criteria and a verdict per member', () => {
    const r = autoQueueEpicEligibility({
      epic,
      members: [m(1), m(2, { assignee: 'steve' }), m(3, { status: 'completed' }), m(4, { status: 'queue' })],
      project,
    });
    expect(r.criteria.map((c) => c.id)).toEqual([
      'epic-refined',
      'epic-not-stale',
      'members-refined',
      'epic-active',
      'epic-not-excluded',
    ]);
    expect(r.criteria.every((c) => c.met)).toBe(true);
    expect(r.members).toEqual([
      { ticketId: 1, verdict: 'eligible' },
      { ticketId: 2, verdict: 'human-work' },
      { ticketId: 3, verdict: 'terminal' },
      { ticketId: 4, verdict: 'in-queue' },
    ]);
  });

  it('members-refined fails on an unrefined open member and makes the others not-eligible', () => {
    const r = autoQueueEpicEligibility({ epic, members: [m(1), m(2, { refined: false })], project });
    expect(r.criteria.find((c) => c.id === 'members-refined')?.met).toBe(false);
    expect(r.members.map((x) => x.verdict)).toEqual(['not-eligible', 'not-eligible']);
  });

  it('a blocked member is not-eligible while its siblings stay eligible', () => {
    const r = autoQueueEpicEligibility({ epic, members: [m(1), m(2)], project, openBlockerIdsByMember: { 2: [1] } });
    expect(r.members).toEqual([
      { ticketId: 1, verdict: 'eligible' },
      { ticketId: 2, verdict: 'not-eligible' },
    ]);
  });

  it('an inactive or excluded Epic fails its own criterion', () => {
    const inactive = autoQueueEpicEligibility({ epic: { ...epic, status: 'backlog' }, members: [m(1)], project });
    expect(inactive.criteria.find((c) => c.id === 'epic-active')?.met).toBe(false);
    const excluded = autoQueueEpicEligibility({ epic: { ...epic, autoQueueExcluded: true }, members: [m(1)], project });
    expect(excluded.criteria.find((c) => c.id === 'epic-not-excluded')?.met).toBe(false);
  });
});

/* ── Mode + verdict wording (D-103 §4, PD-809) ───────────────────────────── */

describe('parseAutoQueueMode', () => {
  it('passes through the three valid modes and defaults everything else to off', () => {
    expect(parseAutoQueueMode('on')).toBe('on');
    expect(parseAutoQueueMode('dry-run')).toBe('dry-run');
    expect(parseAutoQueueMode('off')).toBe('off');
    expect(parseAutoQueueMode(undefined)).toBe('off');
    expect(parseAutoQueueMode('')).toBe('off');
    expect(parseAutoQueueMode('ON')).toBe('off');
  });
});

describe('autoQueueModeNote', () => {
  it('warns while off or dry-run, silent when on', () => {
    expect(autoQueueModeNote('off')).toBe('Auto-queue is off — nothing is promoted automatically.');
    expect(autoQueueModeNote('dry-run')).toBe('Auto-queue is in dry-run — promotions are logged, not applied.');
    expect(autoQueueModeNote('on')).toBeNull();
  });
});

describe('autoQueueVerdictLine', () => {
  it('covers every verdict, splitting the two human-work cases', () => {
    expect(autoQueueVerdictLine('eligible', 'robot', 0)).toBe('Will auto-queue when capacity allows');
    expect(autoQueueVerdictLine('in-queue', 'robot', 0)).toBe('In the Queue');
    expect(autoQueueVerdictLine('terminal', 'robot', 0)).toBe('Completed/Closed — not applicable');
    expect(autoQueueVerdictLine('not-eligible', 'robot', 3)).toBe('Not eligible — 3 unmet');
    expect(autoQueueVerdictLine('human-work', 'steve', 0)).toBe(
      'Not auto-queued — assigned to steve (human work is never automated)',
    );
    expect(autoQueueVerdictLine('human-work', null, 0)).toBe('Not auto-queued — no assignee');
  });
});

describe('autoQueueEpicVerdictLine + roll-up + short labels', () => {
  it('reports unmet Epic criteria, else members auto-queue', () => {
    expect(
      autoQueueEpicVerdictLine({
        criteria: [{ id: 'epic-refined', label: '', description: '', met: false }],
        members: [],
      }),
    ).toBe('Not eligible — 1 unmet');
    expect(
      autoQueueEpicVerdictLine({
        criteria: [{ id: 'epic-refined', label: '', description: '', met: true }],
        members: [],
      }),
    ).toBe('Members auto-queue as they become eligible');
  });

  it('tallies eligible members and names every verdict', () => {
    expect(
      autoQueueMemberRollup([
        { ticketId: 1, verdict: 'eligible' },
        { ticketId: 2, verdict: 'not-eligible' },
        { ticketId: 3, verdict: 'eligible' },
      ]),
    ).toEqual({ eligible: 2, total: 3 });
    expect(AUTO_QUEUE_VERDICT_SHORT['in-queue']).toBe('in queue');
    expect(AUTO_QUEUE_VERDICT_SHORT.terminal).toBe('done');
  });
});

/* ── The server read: routes + capacity ──────────────────────────────────── */

const base = '/api/widgets/task-monitor';
const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  bootstrapMaintenanceHoldsSchema(db); // the app boots it beside the task-monitor schema
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no project');
  db.prepare("UPDATE agent_projects SET robot_enabled = 1, github_repo = 'o/r' WHERE id = ?").run(p.id);
  // Worker-owned; the server only reads it. Mirrors the worker's DDL.
  db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  return { app, db, pid: p.id };
}

/** Set columns directly: fixtures must not have to pass the Queue gate they are not testing. */
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

describe('GET /tickets/:id/queue-eligibility (D-103)', () => {
  it('a member: its criteria, verdict and the capacity snapshot', async () => {
    const { app, db, pid } = setup();
    const { ids } = activeEpic(db, pid, 2);
    const res = await app.inject({ method: 'GET', url: `${base}/tickets/${ids[0]}/queue-eligibility` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isEpic).toBe(false);
    expect(body.eligibility.verdict).toBe('eligible');
    expect(body.capacity.rows.map((r: { id: string }) => r.id)).toEqual([
      'queue-depth',
      'review-wip',
      'epic-in-flight',
      'worker-healthy',
    ]);
  });

  it('a blocked member is not-eligible on unblocked', async () => {
    const { app, db, pid } = setup();
    const { ids } = activeEpic(db, pid, 2);
    addRelation(db, ids[0], ids[1], 'blocks', 'human');
    const body = (await app.inject({ method: 'GET', url: `${base}/tickets/${ids[1]}/queue-eligibility` })).json();
    expect(body.eligibility.verdict).toBe('not-eligible');
    const unblocked = body.eligibility.criteria.find((c: { id: string }) => c.id === 'unblocked');
    expect(unblocked.met).toBe(false);
    // D-103 (PD-809): the remedy flows through so the checklist can link to the blocker.
    expect(unblocked.remedy).toEqual({ kind: 'resolve-blocker', ticketId: ids[0] });
  });

  it('carries the promoter mode from AUTO_QUEUE (default off)', async () => {
    const { app, db, pid } = setup();
    const { ids } = activeEpic(db, pid, 1);
    const prev = process.env.AUTO_QUEUE;
    delete process.env.AUTO_QUEUE;
    try {
      const off = (await app.inject({ method: 'GET', url: `${base}/tickets/${ids[0]}/queue-eligibility` })).json();
      expect(off.mode).toBe('off');
      process.env.AUTO_QUEUE = 'on';
      const on = (await app.inject({ method: 'GET', url: `${base}/tickets/${ids[0]}/queue-eligibility` })).json();
      expect(on.mode).toBe('on');
    } finally {
      if (prev === undefined) delete process.env.AUTO_QUEUE;
      else process.env.AUTO_QUEUE = prev;
    }
  });

  it('an Epic: Epic-level criteria and the member roll-up', async () => {
    const { app, db, pid } = setup();
    const { epicId, ids } = activeEpic(db, pid, 2);
    const body = (await app.inject({ method: 'GET', url: `${base}/tickets/${epicId}/queue-eligibility` })).json();
    expect(body.isEpic).toBe(true);
    expect(body.epicEligibility.criteria).toHaveLength(5);
    expect(body.epicEligibility.members).toEqual([
      { ticketId: ids[0], verdict: 'eligible' },
      { ticketId: ids[1], verdict: 'eligible' },
    ]);
  });

  it('404 for an unknown ticket, 400 for a bad id', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: `${base}/tickets/9999/queue-eligibility` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${base}/tickets/abc/queue-eligibility` })).statusCode).toBe(400);
  });
});

describe('GET /queue-eligibility — the bulk Backlog read (D-103)', () => {
  it('returns every live Backlog non-Epic ticket, plus capacity and per-Epic in-flight counts', async () => {
    const { app, db, pid } = setup();
    const { epicId, ids } = activeEpic(db, pid, 3);
    set(db, ids[2], { status: 'queue' }); // in the Queue → not in the Backlog read, but in flight
    const body = (await app.inject({ method: 'GET', url: `${base}/queue-eligibility` })).json();
    expect(Object.keys(body.tickets).map(Number).sort()).toEqual([ids[0], ids[1]].sort());
    expect(body.tickets[ids[0]].verdict).toBe('eligible');
    expect(body.epicInFlight[epicId]).toBe(1);
    expect(body.tickets[epicId]).toBeUndefined();
    expect(body.capacity.rows).toHaveLength(4);
  });
});

describe('PATCH autoQueueExcluded (D-103)', () => {
  it('round-trips on an Epic and flips its members to not-eligible', async () => {
    const { app, db, pid } = setup();
    const { epicId, ids } = activeEpic(db, pid, 1);
    const res = await app.inject({ method: 'PATCH', url: `${base}/tickets/${epicId}`, payload: { autoQueueExcluded: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoQueueExcluded).toBe(true);
    expect(getTicket(db, epicId)?.autoQueueExcluded).toBe(true);
    const body = (await app.inject({ method: 'GET', url: `${base}/tickets/${ids[0]}/queue-eligibility` })).json();
    expect(body.eligibility.criteria.find((c: { id: string }) => c.id === 'epic-not-excluded').met).toBe(false);
  });

  it('rejects a non-boolean', async () => {
    const { app, db, pid } = setup();
    const { epicId } = activeEpic(db, pid, 1);
    const res = await app.inject({ method: 'PATCH', url: `${base}/tickets/${epicId}`, payload: { autoQueueExcluded: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_AUTO_QUEUE_EXCLUDED');
  });

  it('defaults to false on every new ticket', () => {
    const { db, pid } = setup();
    const e = createTicket(db, { title: 'e', projectId: pid, isEpic: true });
    expect(getTicket(db, e.id)?.autoQueueExcluded).toBe(false);
  });
});

describe('computeAutoQueueCapacity (D-103 §4)', () => {
  function row(db: Database.Database, epicId: number | null, id: string) {
    return computeAutoQueueCapacity(db, epicId).rows.find((r) => r.id === id)!;
  }

  it('queue-depth limit is concurrency × 2, concurrency read from the worker’s published policy (default 1)', () => {
    const { db } = setup();
    heartbeat(db);
    expect(row(db, null, 'queue-depth').limit).toBe(2);
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      ROBOT_CAPACITY_POLICY_KEY,
      JSON.stringify({ concurrency: 3 }),
      Date.now(),
    );
    expect(row(db, null, 'queue-depth').limit).toBe(6);
  });

  it('queue-depth counts only dispatchable robot work and fails at the limit', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 3);
    set(db, ids[0], { status: 'queue' });
    expect(row(db, null, 'queue-depth')).toMatchObject({ current: 1, met: true });
    set(db, ids[1], { status: 'queue' });
    expect(row(db, null, 'queue-depth')).toMatchObject({ current: 2, met: false });
    set(db, ids[1], { agent_state: 'working' }); // dispatched → no longer waiting in the Queue
    expect(row(db, null, 'queue-depth')).toMatchObject({ current: 1, met: true });
  });

  it('review-wip fails at 3 robot tickets in review', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { ids } = activeEpic(db, pid, 3);
    for (const id of ids) set(db, id, { status: 'queue', agent_state: 'in-review' });
    expect(row(db, null, 'review-wip')).toMatchObject({ current: 3, limit: 3, met: false });
  });

  it('epic-in-flight counts this Epic’s queued / working / in-review members, not stuck ones', () => {
    const { db, pid } = setup();
    heartbeat(db);
    const { epicId, ids } = activeEpic(db, pid, 2);
    expect(row(db, epicId, 'epic-in-flight')).toMatchObject({ current: 0, met: true });
    set(db, ids[0], { status: 'queue', agent_state: 'stuck' });
    expect(row(db, epicId, 'epic-in-flight').current).toBe(0);
    set(db, ids[1], { status: 'queue', agent_state: 'working' });
    expect(row(db, epicId, 'epic-in-flight')).toMatchObject({ current: 1, met: false });
  });

  it('worker-healthy fails on a stale heartbeat and on a dispatch pause', () => {
    const { db } = setup();
    expect(row(db, null, 'worker-healthy')).toMatchObject({ met: false, reason: expect.stringMatching(/heartbeat/) });
    heartbeat(db);
    expect(row(db, null, 'worker-healthy').met).toBe(true);
    db.prepare("INSERT INTO robot_state (key, value, updated_at) VALUES ('dispatch_paused', 'test', ?)").run(Date.now());
    const r = computeAutoQueueCapacity(db, null);
    expect(r.rows.find((x) => x.id === 'worker-healthy')).toMatchObject({ met: false, reason: 'Dispatch is paused.' });
    expect(r.ok).toBe(false);
  });
});
