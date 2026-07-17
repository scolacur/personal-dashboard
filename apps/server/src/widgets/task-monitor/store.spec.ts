import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  addRelation,
  appendRefineReply,
  approveRefine,
  archiveTicket,
  computeEpicSummary,
  EpicGuardError,
  listEpicMembers,
  listEpicSummaries,
  createNotification,
  createTicket,
  getLineage,
  listAllRelations,
  listRelations,
  removeRelation,
  removeRelationById,
  unresolvedBlockers,
  QueueBlockedError,
  RelationCycleError,
  SelfRelationError,
  getProjectBySlug,
  getTicket,
  listNotifications,
  listProjects,
  listTicketEvents,
  listTickets,
  markAllNotificationsRead,
  markNotificationRead,
  rejectRefine,
  startRefine,
  unreadNotificationCount,
  updateTicket,
} from './store';

const ROBOT_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

/** Write a refine_proposal event directly (stands in for the agent-worker's propose_commit). */
function seedProposal(db: Database.Database, ticketId: number, proposal: unknown): void {
  db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(ticketId, 'refine_proposal', JSON.stringify(proposal), Date.now());
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function projectId(db: Database.Database, slug: string): number {
  const p = getProjectBySlug(db, slug);
  if (!p) throw new Error(`no project ${slug}`);
  return p.id;
}

describe('bootstrapSchema', () => {
  it('seeds the three known projects with display-id keys', () => {
    const db = freshDb();
    const projects = listProjects(db);
    expect(projects.map((p) => p.slug).sort()).toEqual([
      'core',
      'nervous-system-website',
      'personal-dashboard',
    ]);
    expect(getProjectBySlug(db, 'personal-dashboard')?.key).toBe('PD');
    expect(getProjectBySlug(db, 'core')?.key).toBe('C');
    expect(getProjectBySlug(db, 'personal-dashboard')?.robotEnabled).toBe(true);
    expect(getProjectBySlug(db, 'core')?.robotEnabled).toBe(false);
  });

  it('is idempotent — re-running does not duplicate projects or tags', () => {
    const db = freshDb();
    bootstrapSchema(db);
    bootstrapSchema(db);
    expect(listProjects(db)).toHaveLength(3);
    const tags = db.prepare('SELECT name FROM agent_tags').all() as { name: string }[];
    expect(tags.map((t) => t.name).sort()).toEqual(['Infra', 'UI']);
  });
});

describe('display ids', () => {
  it('are sequential per project and never collide across projects', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const core = projectId(db, 'core');

    expect(createTicket(db, { title: 'a', projectId: pd }).displayId).toBe('PD-1');
    expect(createTicket(db, { title: 'b', projectId: pd }).displayId).toBe('PD-2');
    expect(createTicket(db, { title: 'c', projectId: core }).displayId).toBe('C-1');
    expect(createTicket(db, { title: 'd', projectId: pd }).displayId).toBe('PD-3');
  });

  it('does not reuse a number after archive', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const first = createTicket(db, { title: 'a', projectId: pd });
    expect(first.displayId).toBe('PD-1');
    archiveTicket(db, first.id);
    expect(createTicket(db, { title: 'b', projectId: pd }).displayId).toBe('PD-2');
  });
});

describe('soft delete', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('hides archived tickets from the board but keeps the row', () => {
    const t = createTicket(db, { title: 'archive me', projectId: pd });
    expect(listTickets(db)).toHaveLength(1);

    expect(archiveTicket(db, t.id)).toBe(true);
    expect(listTickets(db)).toHaveLength(0);

    const row = db.prepare('SELECT archived_at FROM agent_tickets WHERE id = ?').get(t.id) as {
      archived_at: number | null;
    };
    expect(row.archived_at).not.toBeNull();
  });

  it('returns false when archiving an already-archived or missing ticket', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(archiveTicket(db, t.id)).toBe(true);
    expect(archiveTicket(db, t.id)).toBe(false);
    expect(archiveTicket(db, 9999)).toBe(false);
  });
});

describe('createTicket with a forced display-id (seed restore)', () => {
  it('preserves the id and advances seq so later auto-ids do not collide', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const restored = createTicket(db, { title: 'restored', projectId: pd, displayId: 'PD-42' });
    expect(restored.displayId).toBe('PD-42');
    // The next auto-allocated id continues past the forced number, not from PD-1.
    const next = createTicket(db, { title: 'fresh', projectId: pd });
    expect(next.displayId).toBe('PD-43');
  });
});

describe('priority migration (legacy low/medium/high → P-levels)', () => {
  it('remaps by status, unsets backlog mediums, and is idempotent', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO agent_tickets (title, status, priority, project_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
    );
    ins.run('h', 'backlog', 'high', pd, now, now);
    ins.run('mc', 'completed', 'medium', pd, now, now);
    ins.run('mb', 'backlog', 'medium', pd, now, now);
    ins.run('lo', 'ready', 'low', pd, now, now);

    // Re-run the migration (it already ran once on the empty DB) against the legacy rows.
    db.prepare("DELETE FROM _migrations WHERE id = 'agent_tickets_priority_to_p_levels'").run();
    bootstrapSchema(db);

    const byTitle = Object.fromEntries(listTickets(db).map((t) => [t.title, t.priority]));
    expect(byTitle['h']).toBe('P1'); // high → P1
    expect(byTitle['mc']).toBe('P3'); // medium + completed → P3
    expect(byTitle['mb']).toBe(null); // medium + backlog → unset
    expect(byTitle['lo']).toBe('P4'); // low → P4
  });
});

describe('D-040 + D-058 lane migration (legacy statuses → single queue model)', () => {
  it('remaps ready→prioritized and the agent lanes→queue (assignee robot), seeding agent_state for linked rows', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO agent_tickets (title, status, priority, project_id, source, github_issue_number, created_at, updated_at)
       VALUES (?, ?, 'none', ?, 'manual', ?, ?, ?)`,
    );
    ins.run('r', 'ready', pd, null, now, now);
    ins.run('q', 'queued', pd, 10, now, now);
    ins.run('ip', 'in_progress', pd, 11, now, now);
    ins.run('ir', 'in_review', pd, 12, now, now);
    ins.run('manual-ip', 'in_progress', pd, null, now, now); // no linked issue → pill not seeded

    // Re-run BOTH lane migrations (both already ran once on the empty DB) against the legacy rows:
    // D-040 collapses to robot_queue; D-058 then collapses robot_queue → queue + assignee robot.
    db.prepare("DELETE FROM _migrations WHERE id = 'agent_tickets_lanes_d040'").run();
    db.prepare("DELETE FROM _migrations WHERE id = 'agent_tickets_queue_model_d058'").run();
    bootstrapSchema(db);

    const byTitle = Object.fromEntries(listTickets(db).map((t) => [t.title, t]));
    expect(byTitle['r'].status).toBe('prioritized');
    expect(byTitle['q'].status).toBe('queue');
    expect(byTitle['q'].assignee).toBe('robot');
    expect(byTitle['q'].agentState).toBe('queued');
    expect(byTitle['ip'].status).toBe('queue');
    expect(byTitle['ip'].agentState).toBe('working');
    expect(byTitle['ir'].status).toBe('queue');
    expect(byTitle['ir'].agentState).toBe('in-review');
    // A row with no linked issue collapses to queue but gets no synthetic pill.
    expect(byTitle['manual-ip'].status).toBe('queue');
    expect(byTitle['manual-ip'].agentState).toBeNull();
  });
});

// D-058 queue-model migration: robot_queue → queue+robot, steve_queue → queue+steve, and the
// `ready` column back-filled from each row's body via the shared isReady.
describe('D-058 queue-model migration', () => {
  const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';
  it('maps robot_queue→queue+robot and steve_queue→queue+steve and back-fills ready', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO agent_tickets (title, body, status, priority, project_id, source, created_at, updated_at)
       VALUES (?, ?, ?, 'none', ?, 'manual', ?, ?)`,
    );
    ins.run('rq-ready', READY_BODY, 'robot_queue', pd, now, now);
    ins.run('sq', null, 'steve_queue', pd, now, now);
    ins.run('bl-ready', READY_BODY, 'backlog', pd, now, now);
    ins.run('bl-unready', 'no sections here', 'backlog', pd, now, now);

    // Force the ready column back to a wrong value so the back-fill's effect is observable.
    db.prepare('UPDATE agent_tickets SET ready = 0').run();
    db.prepare("DELETE FROM _migrations WHERE id = 'agent_tickets_queue_model_d058'").run();
    bootstrapSchema(db);

    const byTitle = Object.fromEntries(listTickets(db).map((t) => [t.title, t]));
    expect(byTitle['rq-ready'].status).toBe('queue');
    expect(byTitle['rq-ready'].assignee).toBe('robot');
    expect(byTitle['rq-ready'].ready).toBe(true);
    expect(byTitle['sq'].status).toBe('queue');
    expect(byTitle['sq'].assignee).toBe('steve');
    expect(byTitle['bl-ready'].ready).toBe(true);
    expect(byTitle['bl-unready'].ready).toBe(false);
  });
});

describe('assignee', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('defaults to null when omitted on create', () => {
    const t = createTicket(db, { title: 'test', projectId: pd });
    expect(t.assignee).toBeNull();
  });

  it('persists explicit assignee on create', () => {
    const t = createTicket(db, { title: 'bot task', projectId: pd, assignee: 'robot' });
    expect(t.assignee).toBe('robot');
  });

  it('persists null assignee on create', () => {
    const t = createTicket(db, { title: 'unowned', projectId: pd, assignee: null });
    expect(t.assignee).toBeNull();
  });

  it('can patch assignee null → robot → null', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(t.assignee).toBeNull();

    const toRobot = updateTicket(db, t.id, { assignee: 'robot' });
    expect(toRobot?.assignee).toBe('robot');

    const toNull = updateTicket(db, t.id, { assignee: null });
    expect(toNull?.assignee).toBeNull();
  });

  it('leaves assignee unchanged when patch omits it', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, assignee: 'robot' });
    const patched = updateTicket(db, t.id, { title: 'renamed' });
    expect(patched?.assignee).toBe('robot');
  });
});

// D-058 REVERSES D-044/D-055: assignee is an independent axis, no longer forced by the lane.
// Entering `queue` leaves the assignee exactly as provided (a hint / null).
describe('assignee is independent of the lane (D-058)', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('does NOT force robot when created directly in queue (assignee omitted → null)', () => {
    const t = createTicket(db, { title: 'auto', projectId: pd, status: 'queue' });
    expect(t.assignee).toBeNull();
  });

  it('keeps the assignee hint when created in queue', () => {
    expect(
      createTicket(db, { title: 'r', projectId: pd, status: 'queue', assignee: 'robot' }).assignee,
    ).toBe('robot');
    expect(
      createTicket(db, { title: 's', projectId: pd, status: 'queue', assignee: 'steve' }).assignee,
    ).toBe('steve');
  });

  it('leaves the assignee hint alone in a non-queue lane on create', () => {
    expect(createTicket(db, { title: 'a', projectId: pd, assignee: 'robot' }).assignee).toBe('robot');
    expect(createTicket(db, { title: 'b', projectId: pd }).assignee).toBeNull();
    expect(
      createTicket(db, { title: 'c', projectId: pd, status: 'prioritized', assignee: 'steve' })
        .assignee,
    ).toBe('steve');
  });

  it('does NOT change the assignee when a ticket is moved into queue (status only)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'prioritized' });
    expect(t.assignee).toBeNull();
    const moved = updateTicket(db, t.id, { status: 'queue' });
    expect(moved?.assignee).toBeNull();
  });

  it('honors an explicit assignee sent alongside a queue transition', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'prioritized' });
    const moved = updateTicket(db, t.id, { status: 'queue', assignee: 'steve' });
    expect(moved?.assignee).toBe('steve');
  });

  it('keeps the assignee when moving OUT of queue', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'queue', assignee: 'robot' });
    expect(t.assignee).toBe('robot');
    const back = updateTicket(db, t.id, { status: 'prioritized' });
    expect(back?.assignee).toBe('robot');
  });
});

// D-058: `ready` is a server-computed formatting property, recomputed on every body write and
// persisted. Not client-settable; the loop reads the persisted flag.
describe('ready (computed on body write, D-058)', () => {
  const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('computes ready from the body on create', () => {
    expect(createTicket(db, { title: 'r', projectId: pd, body: READY_BODY }).ready).toBe(true);
    expect(createTicket(db, { title: 'u', projectId: pd, body: 'loose' }).ready).toBe(false);
    expect(createTicket(db, { title: 'n', projectId: pd }).ready).toBe(false);
  });

  it('recomputes ready when the body is patched (gains and loses shape)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, body: 'loose' });
    expect(t.ready).toBe(false);
    expect(updateTicket(db, t.id, { body: READY_BODY })?.ready).toBe(true);
    // lose a section → drops back to not-ready
    expect(updateTicket(db, t.id, { body: '## Context\nc\n## Task\nt' })?.ready).toBe(false);
  });

  it('leaves ready unchanged when the patch omits body', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, body: READY_BODY });
    expect(updateTicket(db, t.id, { title: 'renamed' })?.ready).toBe(true);
  });

  it('accepts and persists readyBypassed; ready is not client-settable', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, body: 'loose' });
    expect(t.ready).toBe(false);
    expect(t.readyBypassed).toBe(false);
    const bypassed = updateTicket(db, t.id, { readyBypassed: true });
    expect(bypassed?.readyBypassed).toBe(true);
    expect(bypassed?.ready).toBe(false); // body still unshaped → ready stays false
  });
});

describe('closed status', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('can create a ticket with closed status', () => {
    const t = createTicket(db, { title: 'closed ticket', projectId: pd, status: 'closed' });
    expect(t.status).toBe('closed');
  });

  it('can transition a ticket to closed via updateTicket', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    const updated = updateTicket(db, t.id, { status: 'closed' });
    expect(updated?.status).toBe('closed');
  });

  it('orders closed tickets after completed in listTickets', () => {
    createTicket(db, { title: 'done', projectId: pd, status: 'completed' });
    createTicket(db, { title: 'shut', projectId: pd, status: 'closed' });
    createTicket(db, { title: 'wip', projectId: pd, status: 'queue' });
    const statuses = listTickets(db).map((t) => t.status);
    const wipIdx = statuses.indexOf('queue');
    const doneIdx = statuses.indexOf('completed');
    const shutIdx = statuses.indexOf('closed');
    expect(wipIdx).toBeLessThan(doneIdx);
    expect(doneIdx).toBeLessThan(shutIdx);
  });
});

describe('activity log', () => {
  it('records created and status_changed events', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    const t = createTicket(db, { title: 'x', projectId: pd });
    updateTicket(db, t.id, { status: 'prioritized' });
    updateTicket(db, t.id, { priority: 'P1' }); // no status change → no event

    const events = db
      .prepare('SELECT type, detail FROM agent_ticket_events WHERE ticket_id = ? ORDER BY id')
      .all(t.id) as { type: string; detail: string | null }[];
    expect(events.map((e) => e.type)).toEqual(['created', 'status_changed']);
    expect(JSON.parse(events[1].detail!)).toEqual({ from: 'backlog', to: 'prioritized' });
  });
});

describe('notifications (Notification Center, D-040)', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('creates a notification and resolves the ticket display id', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    const n = createNotification(db, {
      kind: 'agent_awaiting_human',
      ticketId: t.id,
      title: 'needs you',
      body: 'Which color?',
    });
    expect(n).not.toBeNull();
    expect(n!.ticketDisplayId).toBe(t.displayId);
    expect(n!.body).toBe('Which color?');
    expect(n!.readAt).toBeNull();
    expect(unreadNotificationCount(db)).toBe(1);
  });

  it('dedups an unread notification of the same ticket+kind, but allows a different kind', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'a' })).not.toBeNull();
    expect(createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'b' })).toBeNull();
    expect(unreadNotificationCount(db)).toBe(1);
    expect(createNotification(db, { kind: 'agent_needs_human', ticketId: t.id, title: 'c' })).not.toBeNull();
    expect(unreadNotificationCount(db)).toBe(2);
  });

  it('allows a new notification of the same kind once the prior one is read', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    const n = createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'a' })!;
    markNotificationRead(db, n.id);
    expect(createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'b' })).not.toBeNull();
  });

  it('lists newest first and filters unread', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    const a = createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'a' })!;
    const t2 = createTicket(db, { title: 'y', projectId: pd });
    createNotification(db, { kind: 'agent_needs_human', ticketId: t2.id, title: 'b' });
    markNotificationRead(db, a.id);
    expect(listNotifications(db)).toHaveLength(2);
    const unread = listNotifications(db, { unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].title).toBe('b');
  });

  it('markAll flips all unread and returns the count', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'a' });
    createNotification(db, { kind: 'agent_needs_human', ticketId: t.id, title: 'b' });
    expect(markAllNotificationsRead(db)).toBe(2);
    expect(unreadNotificationCount(db)).toBe(0);
  });

  it('markNotificationRead is idempotent and returns false for a missing id', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    const n = createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'a' })!;
    expect(markNotificationRead(db, n.id)).toBe(true);
    expect(markNotificationRead(db, n.id)).toBe(true); // already read → still true (row exists)
    expect(markNotificationRead(db, 9999)).toBe(false);
  });

  it('cascades on ticket hard-delete (FK ON DELETE CASCADE)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: 'a' });
    db.prepare('DELETE FROM agent_tickets WHERE id = ?').run(t.id);
    expect(unreadNotificationCount(db)).toBe(0);
  });
});

describe('listNotifications limit (dropdown cap)', () => {
  it('caps the result count, newest first', () => {
    const db = freshDb();
    const pd = projectId(db, 'personal-dashboard');
    for (let i = 0; i < 5; i++) {
      const t = createTicket(db, { title: `t${i}`, projectId: pd });
      createNotification(db, { kind: 'agent_awaiting_human', ticketId: t.id, title: `n${i}` });
    }
    expect(listNotifications(db)).toHaveLength(5);
    const capped = listNotifications(db, { limit: 2 });
    expect(capped).toHaveLength(2);
    expect(capped[0].title).toBe('n4'); // newest (highest id) first
  });
});

describe('ticket events + Refine thread (D-044, PD-267)', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('listTicketEvents returns the activity log oldest-first with parsed JSON detail', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    updateTicket(db, t.id, { status: 'prioritized' }); // logs status_changed
    const events = listTicketEvents(db, t.id);
    expect(events.map((e) => e.type)).toEqual(['created', 'status_changed']);
    expect(events[1].detail).toEqual({ from: 'backlog', to: 'prioritized' });
    expect(events[0].createdAt).toBeLessThanOrEqual(events[1].createdAt);
  });

  it('listTicketEvents is [] for an unknown ticket', () => {
    expect(listTicketEvents(db, 9999)).toEqual([]);
  });

  it('appendRefineReply writes a refine_human event and returns it', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    const ev = appendRefineReply(db, t.id, '  scope it to the widget only  ');
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe('refine_human');
    expect(ev?.detail).toEqual({ text: '  scope it to the widget only  ' });
    const thread = listTicketEvents(db, t.id).filter((e) => e.type === 'refine_human');
    expect(thread).toHaveLength(1);
  });

  it('appendRefineReply returns null for an unknown ticket (no row written)', () => {
    expect(appendRefineReply(db, 9999, 'hi')).toBeNull();
    expect(listTicketEvents(db, 9999)).toEqual([]);
  });

  it('a refine_agent turn round-trips its sessionId through the event detail', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    // Simulate a agent-worker post (the agent-worker writes the same row shape).
    db.prepare(
      'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
    ).run(t.id, 'refine_agent', JSON.stringify({ text: 'here is my plan', sessionId: 'sess-42' }), Date.now());
    const agentEvents = listTicketEvents(db, t.id).filter((e) => e.type === 'refine_agent');
    expect(agentEvents).toHaveLength(1);
    expect((agentEvents[0].detail as { sessionId?: string }).sessionId).toBe('sess-42');
  });
});

describe('startRefine + refineState (D-044, PD-268)', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('writes a kickoff refine_human event (title + body) and returns it', () => {
    const t = createTicket(db, { title: 'Add a widget', body: 'It should show X', projectId: pd });
    const result = startRefine(db, t.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe('refine_human');
    expect((result.event.detail as { text: string }).text).toBe('Add a widget\n\nIt should show X');
    const humanTurns = listTicketEvents(db, t.id).filter((e) => e.type === 'refine_human');
    expect(humanTurns).toHaveLength(1);
  });

  it('is no-op-safe: a second start returns already_started (no second thread)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(startRefine(db, t.id).ok).toBe(true);
    const again = startRefine(db, t.id);
    expect(again).toEqual({ ok: false, reason: 'already_started' });
    expect(listTicketEvents(db, t.id).filter((e) => e.type === 'refine_human')).toHaveLength(1);
  });

  it('returns not_found for an unknown ticket', () => {
    expect(startRefine(db, 9999)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('derives refineState: null → refining (after start) → awaiting-human (after agent turn)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(getTicket(db, t.id)?.refineState).toBeNull();

    startRefine(db, t.id);
    expect(getTicket(db, t.id)?.refineState).toBe('refining');
    expect(listTickets(db).find((x) => x.id === t.id)?.refineState).toBe('refining');

    db.prepare(
      'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
    ).run(t.id, 'refine_agent', JSON.stringify({ text: 'plan', sessionId: 's' }), Date.now() + 1000);
    expect(getTicket(db, t.id)?.refineState).toBe('awaiting-human');
  });
});

describe('relations + Refine commit (D-044, PD-269)', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('addRelation is idempotent and getLineage resolves both directions', () => {
    const parent = createTicket(db, { title: 'parent', projectId: pd });
    const child = createTicket(db, { title: 'child', projectId: pd });
    addRelation(db, parent.id, child.id, 'split');
    addRelation(db, parent.id, child.id, 'split'); // dup ignored
    expect(getLineage(db, parent.id).splitInto.map((r) => r.ticketId)).toEqual([child.id]);
    expect(getLineage(db, child.id).splitFrom.map((r) => r.ticketId)).toEqual([parent.id]);
  });

  it('addRelation persists relates / duplicates types', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    addRelation(db, a.id, b.id, 'relates');
    addRelation(db, a.id, b.id, 'duplicates');
    const types = listRelations(db, a.id).map((r) => r.type).sort();
    expect(types).toEqual(['duplicates', 'relates']);
  });

  it('listRelations resolves both directions and is type-agnostic', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    const c = createTicket(db, { title: 'c', projectId: pd });
    addRelation(db, a.id, b.id, 'relates'); // a → b (outgoing from a)
    addRelation(db, c.id, a.id, 'blocks'); // c → a (incoming to a)

    const rels = listRelations(db, a.id);
    expect(rels).toHaveLength(2);
    const outgoing = rels.find((r) => r.direction === 'from')!;
    expect(outgoing.type).toBe('relates');
    expect(outgoing.other.ticketId).toBe(b.id);
    const incoming = rels.find((r) => r.direction === 'to')!;
    expect(incoming.type).toBe('blocks');
    expect(incoming.other.ticketId).toBe(c.id);
  });

  it('removeRelation deletes exactly the matching link and no-ops when absent', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    addRelation(db, a.id, b.id, 'relates');
    addRelation(db, a.id, b.id, 'duplicates');
    removeRelation(db, a.id, b.id, 'relates');
    expect(listRelations(db, a.id).map((r) => r.type)).toEqual(['duplicates']);
    removeRelation(db, a.id, b.id, 'relates'); // already gone — no throw
    expect(listRelations(db, a.id).map((r) => r.type)).toEqual(['duplicates']);
  });

  it('listAllRelations returns every row as raw endpoints (PD-322 board badges)', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    const c = createTicket(db, { title: 'c', projectId: pd });
    addRelation(db, a.id, b.id, 'split'); // agent default
    addRelation(db, c.id, a.id, 'blocks', 'human');
    const all = listAllRelations(db);
    expect(all).toHaveLength(2);
    const split = all.find((r) => r.type === 'split')!;
    expect(split.fromTicketId).toBe(a.id);
    expect(split.toTicketId).toBe(b.id);
    expect(split.origin).toBe('agent');
    const blocks = all.find((r) => r.type === 'blocks')!;
    expect(blocks.fromTicketId).toBe(c.id);
    expect(blocks.toTicketId).toBe(a.id);
    expect(blocks.origin).toBe('human');
  });

  // ── Relation origin, validation, blocker gate (D-048, PD-321) ──────────────

  it('addRelation defaults origin to agent and accepts human', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    const c = createTicket(db, { title: 'c', projectId: pd });
    addRelation(db, a.id, b.id, 'relates'); // default → agent
    addRelation(db, a.id, c.id, 'relates', 'human');
    const byOther = Object.fromEntries(listRelations(db, a.id).map((r) => [r.other.ticketId, r.origin]));
    expect(byOther[b.id]).toBe('agent');
    expect(byOther[c.id]).toBe('human');
  });

  it('addRelation returns the row id (existing id on idempotent re-add)', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    const first = addRelation(db, a.id, b.id, 'relates');
    const again = addRelation(db, a.id, b.id, 'relates');
    expect(first).toBeGreaterThan(0);
    expect(again).toBe(first);
  });

  it('rejects self-relations for any type', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    expect(() => addRelation(db, a.id, a.id, 'blocks')).toThrow(SelfRelationError);
    expect(() => addRelation(db, a.id, a.id, 'relates')).toThrow(SelfRelationError);
  });

  it('rejects a blocks edge that would close a direct 2-cycle', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    addRelation(db, b.id, a.id, 'blocks'); // a blocked by b
    expect(() => addRelation(db, a.id, b.id, 'blocks')).toThrow(RelationCycleError); // b blocked by a
  });

  it('rejects a blocks edge that would close a deep cycle', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    const c = createTicket(db, { title: 'c', projectId: pd });
    addRelation(db, b.id, a.id, 'blocks'); // a blocked by b
    addRelation(db, c.id, b.id, 'blocks'); // b blocked by c
    expect(() => addRelation(db, a.id, c.id, 'blocks')).toThrow(RelationCycleError); // c blocked by a
  });

  it('does not treat relates/duplicates cycles as errors', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    addRelation(db, a.id, b.id, 'relates');
    expect(() => addRelation(db, b.id, a.id, 'relates')).not.toThrow();
  });

  it('unresolvedBlockers lists open blockers and clears when they go terminal', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const open = createTicket(db, { title: 'open', projectId: pd });
    const done = createTicket(db, { title: 'done', projectId: pd });
    const gone = createTicket(db, { title: 'gone', projectId: pd });
    addRelation(db, open.id, a.id, 'blocks');
    addRelation(db, done.id, a.id, 'blocks');
    addRelation(db, gone.id, a.id, 'blocks');
    updateTicket(db, done.id, { status: 'completed' });
    archiveTicket(db, gone.id);
    expect(unresolvedBlockers(db, a.id).map((b) => b.ticketId)).toEqual([open.id]);
  });

  it('blocker gate: cannot enter queue with an unresolved blocker; lifts once resolved', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const blocker = createTicket(db, { title: 'blocker', projectId: pd });
    addRelation(db, blocker.id, a.id, 'blocks'); // a blocked by blocker
    expect(() => updateTicket(db, a.id, { status: 'queue' })).toThrow(QueueBlockedError);
    // A different (non-queue) transition is unaffected.
    expect(() => updateTicket(db, a.id, { status: 'prioritized' })).not.toThrow();
    // Resolve the blocker → gate lifts.
    updateTicket(db, blocker.id, { status: 'completed' });
    expect(updateTicket(db, a.id, { status: 'queue' })?.status).toBe('queue');
  });

  it('blocker gate is entry-only: blocking an already-queued ticket is allowed at the store level', () => {
    const a = createTicket(db, { title: 'a', projectId: pd, status: 'queue' });
    const blocker = createTicket(db, { title: 'blocker', projectId: pd });
    // Adding the blocker does not throw (PD-322 gates this with a confirm in the UI), and does
    // not evict the already-queued ticket.
    expect(() => addRelation(db, blocker.id, a.id, 'blocks')).not.toThrow();
    expect(getTicket(db, a.id)?.status).toBe('queue');
  });

  it('removeRelationById deletes by row id and reports whether a row went', () => {
    const a = createTicket(db, { title: 'a', projectId: pd });
    const b = createTicket(db, { title: 'b', projectId: pd });
    const relId = addRelation(db, a.id, b.id, 'relates');
    expect(removeRelationById(db, relId)).toBe(true);
    expect(listRelations(db, a.id)).toHaveLength(0);
    expect(removeRelationById(db, relId)).toBe(false);
  });

  it('approveRefine refine_in_place rewrites, routes (assignee from proposal), and marks refined', () => {
    const t = createTicket(db, { title: 'x', body: 'old', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: 'new body', status: 'prioritized', assignee: 'steve' });
    const res = approveRefine(db, t.id);
    expect(res.ok).toBe(true);
    const after = getTicket(db, t.id)!;
    expect(after.body).toBe('new body');
    expect(after.status).toBe('prioritized');
    expect(after.assignee).toBe('steve'); // D-058: assignee is free, honored from the proposal
    expect(after.refined).toBe(true);
    expect(listTicketEvents(db, t.id).some((e) => e.type === 'refine_committed')).toBe(true);
  });

  it('approveRefine refine_in_place parks a proposed queue in prioritized (D-057: no dispatch)', () => {
    const t = createTicket(db, { title: 'x', body: 'old', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'queue' });
    const res = approveRefine(db, t.id);
    expect(res).toMatchObject({ ok: true, queued: false });
    const after = getTicket(db, t.id)!;
    expect(after.status).toBe('prioritized'); // parked, not dispatched
    expect(after.refined).toBe(true);
  });

  it('approveRefine { queue: true } dispatches a non-Epic refine_in_place into queue', () => {
    const t = createTicket(db, { title: 'x', body: 'old', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'prioritized', assignee: 'robot' });
    const res = approveRefine(db, t.id, { queue: true });
    expect(res).toMatchObject({ ok: true, queued: true });
    const after = getTicket(db, t.id)!;
    expect(after.status).toBe('queue');
    expect(after.assignee).toBe('robot'); // D-058: from the proposal, not lane-forced
    expect(after.ready).toBe(true); // recomputed from the ROBOT_BODY on write
    expect(after.refined).toBe(true);
  });

  it('approveRefine { queue: true } queues even an unshaped body (ready is not a hard gate here, D-057)', () => {
    const t = createTicket(db, { title: 'x', body: 'old', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: 'not shaped', status: 'prioritized' });
    const res = approveRefine(db, t.id, { queue: true });
    expect(res).toMatchObject({ ok: true, queued: true });
    const after = getTicket(db, t.id)!;
    expect(after.status).toBe('queue');
    expect(after.ready).toBe(false); // unshaped body → not Ready (dispatch would need ready_bypassed)
  });

  it('approveRefine { queue: true } on an Epic is refused cleanly (EPIC_NOT_QUEUEABLE, no 500, no write)', () => {
    const epic = createTicket(db, { title: 'umbrella', status: 'prioritized', projectId: pd, isEpic: true });
    seedProposal(db, epic.id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'prioritized' });
    const res = approveRefine(db, epic.id, { queue: true });
    expect(res).toMatchObject({ ok: false, reason: 'epic_not_queueable' });
    expect(getTicket(db, epic.id)!.status).toBe('prioritized'); // unchanged
  });

  it('approveRefine plain-approve on an Epic proposing queue never queues it (bug PD-377)', () => {
    const epic = createTicket(db, { title: 'umbrella', status: 'prioritized', projectId: pd, isEpic: true });
    seedProposal(db, epic.id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'queue' });
    const res = approveRefine(db, epic.id);
    expect(res).toMatchObject({ ok: true, queued: false });
    const after = getTicket(db, epic.id)!;
    expect(after.status).toBe('prioritized'); // parked, never queue
    expect(after.isEpic).toBe(true);
    expect(after.refined).toBe(true);
  });

  it('approveRefine { queue: true } is blocked by an unresolved blocker (D-048)', () => {
    const t = createTicket(db, { title: 'x', body: ROBOT_BODY, status: 'prioritized', projectId: pd });
    const blocker = createTicket(db, { title: 'blk', status: 'prioritized', projectId: pd });
    addRelation(db, blocker.id, t.id, 'blocks');
    seedProposal(db, t.id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'prioritized' });
    const res = approveRefine(db, t.id, { queue: true });
    expect(res).toMatchObject({ ok: false, reason: 'blocked_by_unresolved' });
    expect(getTicket(db, t.id)!.status).toBe('prioritized'); // unchanged
  });

  it('approveRefine decompose parks queue-bound children in prioritized (Decompose-A), closes+links the parent', () => {
    const parent = createTicket(db, { title: 'big', status: 'prioritized', projectId: pd });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [
        { title: 'robot part', body: ROBOT_BODY, status: 'queue', assignee: 'robot' },
        { title: 'steve part', body: 'loose is fine', status: 'backlog', assignee: 'steve' },
      ],
    });
    const res = approveRefine(db, parent.id);
    expect(res).toMatchObject({ ok: true, queued: false });
    if (!res.ok) return;
    expect(res.childIds).toHaveLength(2);
    expect(getTicket(db, parent.id)!.status).toBe('closed'); // D-036
    const lineage = getLineage(db, parent.id);
    expect(lineage.splitInto.map((r) => r.title).sort()).toEqual(['robot part', 'steve part']);
    // D-057/D-058: the proposed `queue` child is parked in prioritized — never auto-dispatched.
    // Its assignee hint is preserved (D-058: assignee is free).
    const robotChild = listTickets(db).find((t) => t.title === 'robot part')!;
    expect(robotChild.status).toBe('prioritized');
    expect(robotChild.assignee).toBe('robot');
    // A non-queue lane (backlog) is honored as proposed.
    const steveChild = listTickets(db).find((t) => t.title === 'steve part')!;
    expect(steveChild.status).toBe('backlog');
    expect(steveChild.assignee).toBe('steve');
  });

  it('approveRefine decompose carries each child priority (unset → null)', () => {
    const parent = createTicket(db, { title: 'big', status: 'prioritized', projectId: pd });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [
        { title: 'urgent', body: ROBOT_BODY, status: 'queue', assignee: 'robot', priority: 'P1' },
        { title: 'later', body: 'loose', status: 'backlog', assignee: null, priority: 'P3' },
        { title: 'unset', body: 'loose', status: 'backlog', assignee: null },
      ],
    });
    expect(approveRefine(db, parent.id).ok).toBe(true);
    const byTitle = (t: string) => listTickets(db).find((x) => x.title === t)!;
    expect(byTitle('urgent').priority).toBe('P1');
    expect(byTitle('later').priority).toBe('P3');
    expect(byTitle('unset').priority).toBeNull();
  });

  it('approveRefine refine_in_place applies proposed priority; omitted leaves it unchanged', () => {
    const a = createTicket(db, { title: 'a', status: 'prioritized', priority: 'P4', projectId: pd });
    seedProposal(db, a.id, { mode: 'refine_in_place', body: ROBOT_BODY, priority: 'P0' });
    expect(approveRefine(db, a.id).ok).toBe(true);
    expect(getTicket(db, a.id)!.priority).toBe('P0');

    const b = createTicket(db, { title: 'b', status: 'prioritized', priority: 'P4', projectId: pd });
    seedProposal(db, b.id, { mode: 'refine_in_place', body: ROBOT_BODY });
    expect(approveRefine(db, b.id).ok).toBe(true);
    expect(getTicket(db, b.id)!.priority).toBe('P4'); // unchanged
  });

  it('approveRefine decompose parks an unshaped robot child in prioritized (soft gate, D-057)', () => {
    const parent = createTicket(db, { title: 'big', status: 'prioritized', projectId: pd });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [{ title: 'bad robot', body: 'no sections', status: 'queue', assignee: 'robot' }],
    });
    const res = approveRefine(db, parent.id);
    expect(res.ok).toBe(true); // no longer rejected — the child is created, just not dispatched
    expect(getTicket(db, parent.id)!.status).toBe('closed');
    expect(getLineage(db, parent.id).splitInto).toHaveLength(1);
    const child = listTickets(db).find((t) => t.title === 'bad robot')!;
    expect(child.status).toBe('prioritized'); // parked despite the unshaped body
  });

  it('approveRefine reinterprets a decompose on an Epic as Populate (D-058): members via epic_id, Epic stays open, no split', () => {
    const epic = createTicket(db, { title: 'umbrella', status: 'prioritized', projectId: pd, isEpic: true });
    seedProposal(db, epic.id, {
      mode: 'decompose',
      children: [
        { title: 'member robot', body: ROBOT_BODY, status: 'queue', assignee: 'robot' },
        { title: 'member steve', body: 'loose is fine', status: 'backlog', assignee: 'steve' },
      ],
    });
    const res = approveRefine(db, epic.id);
    expect(res).toMatchObject({ ok: true, mode: 'decompose', queued: false, populated: true });
    if (!res.ok) return;
    expect(res.childIds).toHaveLength(2);
    // Epic is LEFT OPEN (not closed) and its members point back at it via epic_id.
    expect(getTicket(db, epic.id)!.status).toBe('prioritized');
    expect(getTicket(db, epic.id)!.isEpic).toBe(true);
    for (const id of res.childIds!) {
      expect(getTicket(db, id)!.epicId).toBe(epic.id);
    }
    // Populate links by membership only — no `split` lineage is written.
    expect(getLineage(db, epic.id).splitInto).toHaveLength(0);
    // Decompose-A still applies: a proposed `queue` member is parked in prioritized.
    const robotMember = listTickets(db).find((t) => t.title === 'member robot')!;
    expect(robotMember.status).toBe('prioritized');
    expect(robotMember.assignee).toBe('robot');
    const steveMember = listTickets(db).find((t) => t.title === 'member steve')!;
    expect(steveMember.status).toBe('backlog');
  });

  it('approveRefine Populate leaves a non-Epic decompose behaviour unchanged (closes + splits, no populated flag)', () => {
    const parent = createTicket(db, { title: 'plain big', status: 'prioritized', projectId: pd });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [{ title: 'slice', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' }],
    });
    const res = approveRefine(db, parent.id);
    expect(res).toMatchObject({ ok: true, mode: 'decompose' });
    if (!res.ok) return;
    expect(res.populated).toBeUndefined();
    expect(getTicket(db, parent.id)!.status).toBe('closed'); // D-036
    expect(getLineage(db, parent.id).splitInto).toHaveLength(1);
    expect(getTicket(db, res.childIds![0])!.epicId).toBeNull();
  });

  it('approveRefine returns no_proposal when nothing is pending, not_found for unknown', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(approveRefine(db, t.id)).toMatchObject({ ok: false, reason: 'no_proposal' });
    expect(approveRefine(db, 9999)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejectRefine drops the proposal so it is no longer actionable', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: 'b' });
    expect(rejectRefine(db, t.id)).toEqual({ ok: true });
    expect(listTicketEvents(db, t.id).some((e) => e.type === 'refine_rejected')).toBe(true);
    // A second approve now finds nothing pending.
    expect(approveRefine(db, t.id)).toMatchObject({ ok: false, reason: 'no_proposal' });
  });
});

describe('recurring tickets', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('spawns a next occurrence in backlog when a recurring ticket is completed', () => {
    const t = createTicket(db, {
      title: 'Weekly maintenance',
      body: 'Clean up logs',
      priority: 'P3',
      projectId: pd,
      assignee: 'steve',
      recurInterval: 'weekly',
    });
    updateTicket(db, t.id, { status: 'completed' });

    const all = listTickets(db);
    const spawned = all.find((x) => x.id !== t.id);
    expect(spawned).toBeDefined();
    expect(spawned!.title).toBe('Weekly maintenance');
    expect(spawned!.body).toBe('Clean up logs');
    expect(spawned!.priority).toBe('P3');
    expect(spawned!.projectId).toBe(pd);
    expect(spawned!.assignee).toBe('steve');
    expect(spawned!.recurInterval).toBe('weekly');
    expect(spawned!.status).toBe('backlog');
    expect(spawned!.source).toBe('recur');
  });

  it('logs a recurred event on the completed ticket referencing the spawned id', () => {
    const t = createTicket(db, {
      title: 'Weekly maintenance',
      projectId: pd,
      recurInterval: 'weekly',
    });
    updateTicket(db, t.id, { status: 'completed' });

    const events = listTicketEvents(db, t.id);
    const recurredEvent = events.find((e) => e.type === 'recurred');
    expect(recurredEvent).toBeDefined();
    const detail = recurredEvent!.detail as { spawnedId: number; spawnedDisplayId: string };
    expect(typeof detail.spawnedId).toBe('number');
    expect(detail.spawnedDisplayId).toMatch(/^PD-/);
  });

  it('does not spawn when recur_interval is null', () => {
    const t = createTicket(db, { title: 'one-off task', projectId: pd });
    expect(t.recurInterval).toBeNull();
    updateTicket(db, t.id, { status: 'completed' });
    expect(listTickets(db)).toHaveLength(1);
  });

  it('does not spawn when transitioning to a non-completed status', () => {
    const t = createTicket(db, {
      title: 'Weekly maintenance',
      projectId: pd,
      recurInterval: 'weekly',
    });
    updateTicket(db, t.id, { status: 'prioritized' });
    expect(listTickets(db)).toHaveLength(1);
  });

  it('does not spawn a second time when already completed', () => {
    const t = createTicket(db, {
      title: 'Weekly maintenance',
      projectId: pd,
      recurInterval: 'weekly',
    });
    updateTicket(db, t.id, { status: 'completed' });
    // Patching an already-completed ticket to completed again should not spawn another.
    updateTicket(db, t.id, { status: 'completed' });
    // One original + one spawned occurrence = 2 total.
    expect(listTickets(db)).toHaveLength(2);
  });

  it('spawned ticket gets its own sequential display id', () => {
    const t = createTicket(db, {
      title: 'Weekly maintenance',
      projectId: pd,
      recurInterval: 'weekly',
    });
    expect(t.displayId).toBe('PD-1');
    updateTicket(db, t.id, { status: 'completed' });

    const all = listTickets(db);
    const spawned = all.find((x) => x.id !== t.id)!;
    expect(spawned.displayId).toBe('PD-2');
  });

  it('persists recurInterval on createTicket when provided', () => {
    const t = createTicket(db, {
      title: 'Daily standup',
      projectId: pd,
      recurInterval: 'daily',
    });
    expect(t.recurInterval).toBe('daily');
    // Verify it roundtrips through getTicket.
    expect(getTicket(db, t.id)!.recurInterval).toBe('daily');
  });
});

describe('epics (D-054, PD-336)', () => {
  let db: Database.Database;
  let pd: number;
  let core: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
    core = projectId(db, 'core');
  });

  function epic(title = 'Epic'): number {
    return createTicket(db, { title, projectId: pd, isEpic: true }).id;
  }

  it('creates an Epic (isEpic true, epicId null) and a member pointing at it', () => {
    const e = epic();
    expect(getTicket(db, e)!.isEpic).toBe(true);
    expect(getTicket(db, e)!.epicId).toBeNull();
    const m = createTicket(db, { title: 'member', projectId: pd, epicId: e });
    expect(m.epicId).toBe(e);
    expect(m.isEpic).toBe(false);
  });

  it('forces epicId null when isEpic is set (no nesting)', () => {
    const e = epic();
    const also = createTicket(db, { title: 'also epic', projectId: pd, isEpic: true, epicId: e });
    expect(also.isEpic).toBe(true);
    expect(also.epicId).toBeNull();
  });

  it('rejects membership guards: not-an-epic, missing, cross-project', () => {
    const plain = createTicket(db, { title: 'plain', projectId: pd });
    const e = epic();
    expect(() => createTicket(db, { title: 'x', projectId: pd, epicId: plain.id })).toThrow(EpicGuardError);
    expect(() => createTicket(db, { title: 'x', projectId: pd, epicId: 99999 })).toThrow(EpicGuardError);
    // cross-project: member in `core` under a `pd` epic
    expect(() => createTicket(db, { title: 'x', projectId: core, epicId: e })).toThrow(EpicGuardError);
    try {
      createTicket(db, { title: 'x', projectId: core, epicId: e });
    } catch (err) {
      expect((err as EpicGuardError).code).toBe('CROSS_PROJECT');
    }
  });

  it('an Epic can never enter queue (create or update), regardless of assignee', () => {
    expect(() => createTicket(db, { title: 'e', projectId: pd, isEpic: true, status: 'queue' })).toThrow(
      EpicGuardError,
    );
    expect(() =>
      createTicket(db, { title: 'e2', projectId: pd, isEpic: true, status: 'queue', assignee: 'steve' }),
    ).toThrow(EpicGuardError);
    const e = epic();
    expect(() => updateTicket(db, e, { status: 'queue' })).toThrow(EpicGuardError);
    expect(() => updateTicket(db, e, { status: 'queue', assignee: 'steve' })).toThrow(EpicGuardError);
  });

  it('refuses un-flagging an Epic that still has members', () => {
    const e = epic();
    createTicket(db, { title: 'm', projectId: pd, epicId: e });
    try {
      updateTicket(db, e, { isEpic: false });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as EpicGuardError).code).toBe('HAS_MEMBERS');
    }
  });

  it('derives lane + roll-up per D-054', () => {
    const e = epic();
    // empty → backlog
    expect(computeEpicSummary(db, e)).toMatchObject({ done: 0, total: 0, derivedLane: 'backlog' });
    const m1 = createTicket(db, { title: 'm1', projectId: pd, epicId: e, status: 'backlog' }).id;
    const m2 = createTicket(db, { title: 'm2', projectId: pd, epicId: e, status: 'prioritized' }).id;
    // mixed backlog + prioritized → least-advanced pending = backlog
    expect(computeEpicSummary(db, e).derivedLane).toBe('backlog');
    // a member in the queue → in_progress
    updateTicket(db, m2, { status: 'queue' });
    expect(computeEpicSummary(db, e).derivedLane).toBe('in_progress');
    // all done (one completed, one closed) → completed; roll-up counts both as done
    updateTicket(db, m1, { status: 'completed' });
    updateTicket(db, m2, { status: 'closed' });
    const s = computeEpicSummary(db, e);
    expect(s).toMatchObject({ done: 2, total: 2, derivedLane: 'completed' });
    // all closed → closed
    updateTicket(db, m1, { status: 'closed' });
    expect(computeEpicSummary(db, e).derivedLane).toBe('closed');
  });

  it('listEpicMembers + listEpicSummaries see only live members', () => {
    const e = epic();
    const m = createTicket(db, { title: 'm', projectId: pd, epicId: e });
    createTicket(db, { title: 'm2', projectId: pd, epicId: e });
    expect(listEpicMembers(db, e).map((t) => t.id).sort()).toContain(m.id);
    expect(listEpicMembers(db, e)).toHaveLength(2);
    const summaries = listEpicSummaries(db);
    expect(summaries.find((s) => s.ticketId === e)).toMatchObject({ total: 2 });
  });

  it('archive unlinks members by default, cascades with the flag', () => {
    const e1 = epic('e1');
    const m1 = createTicket(db, { title: 'm1', projectId: pd, epicId: e1 });
    archiveTicket(db, e1); // default: unlink
    expect(getTicket(db, m1.id)!.archivedAt).toBeNull();
    expect(getTicket(db, m1.id)!.epicId).toBeNull();

    const e2 = epic('e2');
    const m2 = createTicket(db, { title: 'm2', projectId: pd, epicId: e2 });
    archiveTicket(db, e2, { cascadeMembers: true });
    expect(getTicket(db, m2.id)!.archivedAt).not.toBeNull();
  });

  it('decompose on an Epic populates members (D-058); a member decompose still splits + inherits epic_id', () => {
    // D-058: decompose on an epic is reinterpreted as Populate — the child becomes a member.
    const e = epic();
    seedProposal(db,e, {
      mode: 'decompose',
      children: [{ title: 'c', body: '## Context\n## Task\n## Done When\n## Out of scope', status: 'backlog' }],
    });
    const r = approveRefine(db, e);
    expect(r).toMatchObject({ ok: true, populated: true });
    if (r.ok && r.childIds) {
      for (const cid of r.childIds) expect(getTicket(db, cid)!.epicId).toBe(e);
    }
    expect(getTicket(db, e)!.status).not.toBe('closed'); // Epic left open

    // a member decomposed → children stay under the same epic
    const member = createTicket(db, { title: 'member', projectId: pd, epicId: e });
    seedProposal(db,member.id, {
      mode: 'decompose',
      children: [{ title: 'child', body: 'b', status: 'backlog' }],
    });
    const r2 = approveRefine(db, member.id);
    expect(r2.ok).toBe(true);
    if (r2.ok && r2.childIds) {
      for (const cid of r2.childIds) expect(getTicket(db, cid)!.epicId).toBe(e);
    }
  });
});
