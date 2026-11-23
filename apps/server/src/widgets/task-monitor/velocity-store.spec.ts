import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { getRunReport, getVelocityReport } from './velocity-store';

/** Epic PD-895 — the cross-ticket SQL feeding the pure velocity reconstruction. */

const DAY = 24 * 60 * 60 * 1000;
const MON = Date.UTC(2026, 10, 2, 5); // Monday 00:00 Eastern

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function ticket(
  db: Database.Database,
  o: { project: number; assignee?: string | null; epic?: boolean; archived?: boolean },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO agent_tickets (title, project_id, assignee, is_epic, archived_at, created_at, updated_at)
         VALUES ('t', ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.project, o.assignee ?? null, o.epic ? 1 : 0, o.archived ? MON : null, MON, MON)
      .lastInsertRowid,
  );
}

function event(db: Database.Database, ticketId: number, type: string, at: number, detail?: object) {
  db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(ticketId, type, detail ? JSON.stringify(detail) : null, at);
}

function projectIds(db: Database.Database): [number, number] {
  const now = Date.now();
  const ins = db.prepare(
    'INSERT INTO agent_projects (slug, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  return [
    Number(ins.run('velo-a', 'A', 'VA', now, now).lastInsertRowid),
    Number(ins.run('velo-b', 'B', 'VB', now, now).lastInsertRowid),
  ];
}

describe('getVelocityReport', () => {
  it('reads both completion paths, ignores unrelated events and archived tickets, filters by project', () => {
    const db = freshDb();
    const [a, b] = projectIds(db);
    const t1 = ticket(db, { project: a, assignee: 'robot' });
    const t2 = ticket(db, { project: a, assignee: 'steve' });
    const gone = ticket(db, { project: a, assignee: 'steve', archived: true });
    const other = ticket(db, { project: b, assignee: 'robot' });
    for (const t of [t1, t2, gone, other]) event(db, t, 'created', MON);
    event(db, t1, 'robot_dispatched', MON + DAY);
    event(db, t1, 'robot_completed', MON + 2 * DAY);
    event(db, t1, 'status_changed', MON + 2 * DAY, { from: 'in-review', to: 'completed' });
    event(db, t2, 'status_changed', MON + 3 * DAY, { from: 'queue', to: 'completed' });
    event(db, gone, 'status_changed', MON + 3 * DAY, { to: 'completed' });
    event(db, other, 'robot_completed', MON + DAY);

    const r = getVelocityReport(db, { projectId: a }, MON + 5 * DAY);
    expect(r.startDate).toBe(MON + 2 * DAY);
    expect(r.totals.ticketsCompleted).toEqual({ robot: 1, steve: 1, unassigned: 0 });
    expect(r.weeks).toHaveLength(1);

    const all = getVelocityReport(db, {}, MON + 5 * DAY);
    expect(all.totals.ticketsCompleted.robot).toBe(2);
    expect(all.startDate).toBe(MON + DAY);
  });
});

describe('getRunReport', () => {
  it('returns the empty report when agent_runs does not exist (worker never ran)', () => {
    expect(getRunReport(freshDb(), {}, MON)).toMatchObject({ startDate: null, weeks: [] });
  });

  it('aggregates runs, scoped by project through the ticket', () => {
    const db = freshDb();
    const [a, b] = projectIds(db);
    const ta = ticket(db, { project: a });
    const tb = ticket(db, { project: b });
    db.exec(`CREATE TABLE agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, branch TEXT NOT NULL,
      status TEXT NOT NULL, fault_tier TEXT, turns INTEGER, max_turns INTEGER,
      started_at INTEGER NOT NULL, finished_at INTEGER)`);
    const ins = db.prepare(
      `INSERT INTO agent_runs (ticket_id, branch, status, fault_tier, turns, max_turns, started_at, finished_at)
       VALUES (?, 'b', ?, ?, 10, 50, ?, ?)`,
    );
    ins.run(ta, 'error', 'deterministic', MON, MON + 60000);
    ins.run(ta, 'handed-off', null, MON + DAY, MON + DAY + 60000);
    ins.run(tb, 'handed-off', null, MON, MON + 60000);

    const r = getRunReport(db, { projectId: a }, MON + 2 * DAY);
    expect(r.totals).toEqual({ runs: 2, succeeded: 1, failed: 1, parked: 0 });
    expect(r.weeks[0]).toMatchObject({ ticketsRetried: 1, successRate: 0.5 });
    expect(r.weeks[0].faults.deterministic).toBe(1);
    expect(getRunReport(db, {}, MON + 2 * DAY).totals.runs).toBe(3);
  });
});
