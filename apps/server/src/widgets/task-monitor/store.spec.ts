import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  addRelation,
  appendRefineReply,
  approveRefine,
  archiveTicket,
  createNotification,
  createTicket,
  getLineage,
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

const SORTIE_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

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
    expect(getProjectBySlug(db, 'personal-dashboard')?.sortieEnabled).toBe(true);
    expect(getProjectBySlug(db, 'core')?.sortieEnabled).toBe(false);
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

describe('D-040 lane migration (legacy statuses → 6-lane model)', () => {
  it('remaps ready→prioritized and the agent lanes→robot_queue, seeding agent_state for linked rows', () => {
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

    // Re-run the lane migration (it already ran once on the empty DB) against the legacy rows.
    db.prepare("DELETE FROM _migrations WHERE id = 'agent_tickets_lanes_d040'").run();
    bootstrapSchema(db);

    const byTitle = Object.fromEntries(listTickets(db).map((t) => [t.title, t]));
    expect(byTitle['r'].status).toBe('prioritized');
    expect(byTitle['q'].status).toBe('robot_queue');
    expect(byTitle['q'].agentState).toBe('queued');
    expect(byTitle['ip'].status).toBe('robot_queue');
    expect(byTitle['ip'].agentState).toBe('working');
    expect(byTitle['ir'].status).toBe('robot_queue');
    expect(byTitle['ir'].agentState).toBe('in-review');
    // A row with no linked issue collapses to robot_queue but gets no synthetic pill.
    expect(byTitle['manual-ip'].status).toBe('robot_queue');
    expect(byTitle['manual-ip'].agentState).toBeNull();
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

// D-044: entering a queue lane forces the matching assignee (robot_queue⇒robot,
// steve_queue⇒steve), overriding any prior value or hint. Non-queue lanes leave
// assignee free. Enforced in the store so it holds for every writer.
describe('lane→assignee invariant (D-044)', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  function lastAssigneeEvent(ticketId: number): { from: unknown; to: unknown } | null {
    const row = db
      .prepare(
        `SELECT detail FROM agent_ticket_events
          WHERE ticket_id = ? AND type = 'assignee_changed'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(ticketId) as { detail: string | null } | undefined;
    return row?.detail ? (JSON.parse(row.detail) as { from: unknown; to: unknown }) : null;
  }

  it('forces robot when created directly in robot_queue (assignee omitted)', () => {
    const t = createTicket(db, { title: 'auto', projectId: pd, status: 'robot_queue' });
    expect(t.assignee).toBe('robot');
  });

  it('forces steve when created directly in steve_queue', () => {
    const t = createTicket(db, { title: 'auto', projectId: pd, status: 'steve_queue' });
    expect(t.assignee).toBe('steve');
  });

  it('queue lane on create overrides a conflicting assignee hint', () => {
    const t = createTicket(db, {
      title: 'conflict',
      projectId: pd,
      status: 'robot_queue',
      assignee: 'steve',
    });
    expect(t.assignee).toBe('robot');
  });

  it('leaves the assignee hint alone in a non-queue lane on create', () => {
    expect(createTicket(db, { title: 'a', projectId: pd, assignee: 'robot' }).assignee).toBe('robot');
    expect(createTicket(db, { title: 'b', projectId: pd }).assignee).toBeNull();
    expect(
      createTicket(db, { title: 'c', projectId: pd, status: 'prioritized', assignee: 'steve' })
        .assignee,
    ).toBe('steve');
  });

  it('forces the assignee when a ticket is moved into a queue lane (manual drag: status only)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'prioritized' });
    expect(t.assignee).toBeNull();

    const robot = updateTicket(db, t.id, { status: 'robot_queue' });
    expect(robot?.assignee).toBe('robot');
    expect(lastAssigneeEvent(t.id)).toEqual({ from: null, to: 'robot' });

    const steve = updateTicket(db, t.id, { status: 'steve_queue' });
    expect(steve?.assignee).toBe('steve');
    expect(lastAssigneeEvent(t.id)).toEqual({ from: 'robot', to: 'steve' });
  });

  it('overrides a conflicting assignee sent alongside a queue-lane transition', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'prioritized' });
    const moved = updateTicket(db, t.id, { status: 'robot_queue', assignee: 'steve' });
    expect(moved?.assignee).toBe('robot');
  });

  it('does not clear the assignee when moving OUT of a queue lane (becomes a hint)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'robot_queue' });
    expect(t.assignee).toBe('robot');
    const back = updateTicket(db, t.id, { status: 'prioritized' });
    expect(back?.assignee).toBe('robot');
  });

  it('logs assignee_changed only when the assignee actually changes', () => {
    // Already robot in robot_queue → a same-lane no-op patch must not log a change.
    const t = createTicket(db, { title: 'x', projectId: pd, status: 'robot_queue' });
    updateTicket(db, t.id, { title: 'renamed' });
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_ticket_events WHERE ticket_id = ? AND type = 'assignee_changed'`,
      )
      .get(t.id) as { n: number };
    expect(count.n).toBe(0);
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
    createTicket(db, { title: 'wip', projectId: pd, status: 'robot_queue' });
    const statuses = listTickets(db).map((t) => t.status);
    const wipIdx = statuses.indexOf('robot_queue');
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

  it('derives refineState: null → grilling (after start) → awaiting-human (after agent turn)', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(getTicket(db, t.id)?.refineState).toBeNull();

    startRefine(db, t.id);
    expect(getTicket(db, t.id)?.refineState).toBe('grilling');
    expect(listTickets(db).find((x) => x.id === t.id)?.refineState).toBe('grilling');

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

  it('approveRefine refine_in_place rewrites, routes, and marks refined', () => {
    const t = createTicket(db, { title: 'x', body: 'old', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: 'new body', status: 'steve_queue' });
    const res = approveRefine(db, t.id);
    expect(res.ok).toBe(true);
    const after = getTicket(db, t.id)!;
    expect(after.body).toBe('new body');
    expect(after.status).toBe('steve_queue');
    expect(after.assignee).toBe('steve'); // lane invariant
    expect(after.refined).toBe(true);
    expect(listTicketEvents(db, t.id).some((e) => e.type === 'refine_committed')).toBe(true);
  });

  it('approveRefine refine_in_place into robot_queue requires a Sortie-ready body', () => {
    const t = createTicket(db, { title: 'x', body: 'old', projectId: pd });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: 'not shaped', status: 'robot_queue' });
    const res = approveRefine(db, t.id);
    expect(res).toMatchObject({ ok: false, reason: 'child_not_sortie_ready' });
    expect(getTicket(db, t.id)!.status).toBe('backlog'); // unchanged
  });

  it('approveRefine decompose creates routed children, closes+links the parent', () => {
    const parent = createTicket(db, { title: 'big', status: 'prioritized', projectId: pd });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [
        { title: 'robot part', body: SORTIE_BODY, status: 'robot_queue', assignee: 'robot' },
        { title: 'steve part', body: 'loose is fine', status: 'steve_queue', assignee: 'steve' },
      ],
    });
    const res = approveRefine(db, parent.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.childIds).toHaveLength(2);
    expect(getTicket(db, parent.id)!.status).toBe('closed'); // D-036
    const lineage = getLineage(db, parent.id);
    expect(lineage.splitInto.map((r) => r.title).sort()).toEqual(['robot part', 'steve part']);
    const robotChild = listTickets(db).find((t) => t.title === 'robot part')!;
    expect(robotChild.status).toBe('robot_queue');
    expect(robotChild.assignee).toBe('robot');
  });

  it('approveRefine decompose rejects a non-Sortie-ready robot child (no writes)', () => {
    const parent = createTicket(db, { title: 'big', status: 'prioritized', projectId: pd });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [{ title: 'bad robot', body: 'no sections', status: 'robot_queue', assignee: 'robot' }],
    });
    const res = approveRefine(db, parent.id);
    expect(res).toMatchObject({ ok: false, reason: 'child_not_sortie_ready', detail: 'bad robot' });
    expect(getTicket(db, parent.id)!.status).toBe('prioritized'); // unchanged
    expect(getLineage(db, parent.id).splitInto).toHaveLength(0);
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
