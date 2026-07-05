import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  archiveTicket,
  createNotification,
  createTicket,
  getProjectBySlug,
  listNotifications,
  listProjects,
  listTickets,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
  updateTicket,
} from './store';

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
