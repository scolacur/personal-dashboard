import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  archiveTicket,
  createTicket,
  getProjectBySlug,
  listProjects,
  listTickets,
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

describe('assignee', () => {
  let db: Database.Database;
  let pd: number;
  beforeEach(() => {
    db = freshDb();
    pd = projectId(db, 'personal-dashboard');
  });

  it('defaults to steve when omitted on create', () => {
    const t = createTicket(db, { title: 'test', projectId: pd });
    expect(t.assignee).toBe('steve');
  });

  it('persists explicit assignee on create', () => {
    const t = createTicket(db, { title: 'bot task', projectId: pd, assignee: 'robot' });
    expect(t.assignee).toBe('robot');
  });

  it('persists null assignee on create', () => {
    const t = createTicket(db, { title: 'unowned', projectId: pd, assignee: null });
    expect(t.assignee).toBeNull();
  });

  it('can patch assignee steve → robot → null', () => {
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(t.assignee).toBe('steve');

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
    createTicket(db, { title: 'wip', projectId: pd, status: 'in_progress' });
    const statuses = listTickets(db).map((t) => t.status);
    const wipIdx = statuses.indexOf('in_progress');
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
    updateTicket(db, t.id, { status: 'ready' });
    updateTicket(db, t.id, { priority: 'P1' }); // no status change → no event

    const events = db
      .prepare('SELECT type, detail FROM agent_ticket_events WHERE ticket_id = ? ORDER BY id')
      .all(t.id) as { type: string; detail: string | null }[];
    expect(events.map((e) => e.type)).toEqual(['created', 'status_changed']);
    expect(JSON.parse(events[1].detail!)).toEqual({ from: 'backlog', to: 'ready' });
  });
});
