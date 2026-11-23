import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  getBugReport,
  getEpicBurndowns,
  getIntroductionReport,
  getRunReport,
  getVelocityReport,
  loadLifecycles,
} from './velocity-store';

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
    // PD-925: the Robot is credited for the PRs it opened (robot/* branch).
    db.exec(`CREATE TABLE agent_runs (ticket_id INTEGER, branch TEXT, pr_url TEXT)`);
    for (const t of [t1, other]) {
      db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)').run(
        t,
        `robot/t${t}`,
        'https://x/pull/1',
      );
    }

    const r = getVelocityReport(db, { projectId: a }, MON + 5 * DAY);
    expect(r.startDate).toBe(MON + 2 * DAY);
    expect(r.totals.ticketsCompleted).toEqual({ robot: 1, steve: 1, unassigned: 0 });
    expect(r.weeks).toHaveLength(1);

    const all = getVelocityReport(db, {}, MON + 5 * DAY);
    expect(all.totals.ticketsCompleted.robot).toBe(2);
    expect(all.startDate).toBe(MON + DAY);
  });
});

describe('loadLifecycles completion credit (PD-925)', () => {
  it('credits the Robot only for a robot/* branch run with a PR', () => {
    const db = freshDb();
    const [a] = projectIds(db);
    const robotMade = ticket(db, { project: a, assignee: 'robot' });
    const adopted = ticket(db, { project: a, assignee: 'robot' });
    const noPr = ticket(db, { project: a, assignee: 'robot' });
    db.exec(`CREATE TABLE agent_runs (ticket_id INTEGER, branch TEXT, pr_url TEXT)`);
    const run = db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)');
    run.run(robotMade, `robot/t${robotMade}`, 'https://github.com/o/r/pull/1');
    run.run(adopted, 'pd-925-session-branch', 'https://github.com/o/r/pull/2');
    run.run(noPr, `robot/t${noPr}`, null);
    const credit = new Map(loadLifecycles(db).map((l) => [l.id, l.credit]));
    expect(credit.get(robotMade)).toBe('robot');
    expect(credit.get(adopted)).toBe('steve');
    expect(credit.get(noPr)).toBe('steve');
  });

  it('works when agent_runs does not exist', () => {
    const db = freshDb();
    const [a] = projectIds(db);
    const id = ticket(db, { project: a, assignee: 'robot' });
    expect(loadLifecycles(db).find((l) => l.id === id)?.credit).toBe('steve');
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

describe('getEpicBurndowns', () => {
  it("replays an Epic's live members and ignores archived ones and other projects' Epics", () => {
    const db = freshDb();
    const [a, b] = projectIds(db);
    const epic = ticket(db, { project: a, epic: true });
    const otherEpic = ticket(db, { project: b, epic: true });
    const m1 = ticket(db, { project: a });
    const m2 = ticket(db, { project: a });
    const gone = ticket(db, { project: a, archived: true });
    const mb = ticket(db, { project: b });
    const setEpic = db.prepare('UPDATE agent_tickets SET epic_id = ? WHERE id = ?');
    for (const m of [m1, m2, gone]) setEpic.run(epic, m);
    setEpic.run(otherEpic, mb);
    for (const t of [m1, m2, gone, mb]) event(db, t, 'created', MON);
    event(db, m1, 'status_changed', MON + DAY, { to: 'completed' });

    const out = getEpicBurndowns(db, { projectId: a }, MON + 2 * DAY);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: epic,
      memberCount: 2,
      now: { open: 1, done: 1, dropped: 0 },
    });
    expect(getEpicBurndowns(db, {}, MON + 2 * DAY)).toHaveLength(2);
  });
});

describe('getBugReport', () => {
  it("counts only kind = 'bug' tickets in scope, with severity from priority", () => {
    const db = freshDb();
    const [a, b] = projectIds(db);
    const bug = ticket(db, { project: a });
    const feature = ticket(db, { project: a });
    const otherProject = ticket(db, { project: b });
    const set = db.prepare('UPDATE agent_tickets SET kind = ?, priority = ? WHERE id = ?');
    set.run('bug', 'P1', bug);
    set.run('feature', 'P1', feature);
    set.run('bug', 'P2', otherProject);
    for (const t of [bug, feature, otherProject]) event(db, t, 'created', MON);
    event(db, bug, 'status_changed', MON + 2 * DAY, { to: 'completed' });

    const r = getBugReport(db, { projectId: a }, MON + 3 * DAY);
    expect(r.totals).toEqual({ bugs: 1, fixed: 1, openNow: { high: 0, medium: 0, low: 0 } });
    expect(r.weeks[0].fixed.high).toBe(1);
    expect(getBugReport(db, {}, MON + 3 * DAY).totals.bugs).toBe(2);
  });
});

describe('getIntroductionReport', () => {
  it('is empty when the worker never created the szz tables', () => {
    expect(getIntroductionReport(freshDb(), {}, MON)).toMatchObject({
      computedAt: null,
      bugs: [],
      weeks: [],
    });
  });

  it('joins the worker rows to ticket title, filing and fix dates', () => {
    const db = freshDb();
    const [a] = projectIds(db);
    const b = ticket(db, { project: a });
    event(db, b, 'created', MON + 10 * DAY);
    event(db, b, 'status_changed', MON + 12 * DAY, { to: 'completed' });
    db.exec(`
      CREATE TABLE szz_bug (ticket_id INTEGER PRIMARY KEY, status TEXT, fix_shas TEXT, computed_at INTEGER);
      CREATE TABLE szz_candidate (ticket_id INTEGER, sha TEXT, pr_number INTEGER, ticket_ids TEXT, robot INTEGER,
        committed_at INTEGER, lines INTEGER, is_top INTEGER);
      CREATE TABLE szz_pr (pr_number INTEGER PRIMARY KEY, sha TEXT, merged_at INTEGER, robot INTEGER);
    `);
    db.prepare('INSERT INTO szz_bug VALUES (?, ?, ?, ?)').run(b, 'traced', '[]', 99);
    const ins = db.prepare('INSERT INTO szz_candidate VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(b, 'top', 251, '["PD-346"]', 0, MON, 20, 1);
    ins.run(b, 'other', 230, '["PD-342"]', 0, MON - DAY, 8, 0);
    db.prepare('INSERT INTO szz_pr VALUES (?, ?, ?, ?)').run(251, 'top', MON, 0);

    const r = getIntroductionReport(db, { projectId: a }, MON + 20 * DAY);
    expect(r.bugs).toHaveLength(1);
    expect(r.bugs[0]).toMatchObject({
      ticketId: b,
      status: 'traced',
      filedAt: MON + 10 * DAY,
      fixedAt: MON + 12 * DAY,
      top: { prNumber: 251, tickets: ['PD-346'], lines: 20 },
    });
    expect(r.bugs[0].candidates.map((c) => c.prNumber)).toEqual([251, 230]);
    expect(r.medianLagDays).toBe(10);
    expect(r.computedAt).toBe(99);
  });

  describe('project filter (PD-922)', () => {
    function seeded() {
      const db = freshDb();
      const [a, b] = projectIds(db);
      const now = Date.now();
      const c = Number(
        db
          .prepare(
            'INSERT INTO agent_projects (slug, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('velo-c', 'C', 'VC', now, now).lastInsertRowid,
      );
      const repo = db.prepare('UPDATE agent_projects SET github_repo = ? WHERE id = ?');
      repo.run('me/worker', a);
      repo.run('me/other', b); // c has no repo at all
      const bug = ticket(db, { project: a });
      event(db, bug, 'created', MON + 10 * DAY);
      event(db, bug, 'status_changed', MON + 12 * DAY, { to: 'completed' });
      db.exec(`
        CREATE TABLE szz_bug (ticket_id INTEGER PRIMARY KEY, status TEXT, fix_shas TEXT, computed_at INTEGER);
        CREATE TABLE szz_candidate (ticket_id INTEGER, sha TEXT, pr_number INTEGER, ticket_ids TEXT, robot INTEGER,
          committed_at INTEGER, lines INTEGER, is_top INTEGER);
        CREATE TABLE szz_pr (pr_number INTEGER PRIMARY KEY, sha TEXT, merged_at INTEGER, robot INTEGER);
      `);
      db.prepare('INSERT INTO szz_bug VALUES (?, ?, ?, ?)').run(bug, 'traced', '[]', 99);
      db.prepare('INSERT INTO szz_candidate VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        bug,
        'top',
        251,
        '[]',
        0,
        MON,
        20,
        1,
      );
      db.prepare('INSERT INTO szz_pr VALUES (?, ?, ?, ?)').run(251, 'top', MON, 0);
      return { db, a, b, c };
    }

    it('keeps the data for the project on the analysed repo', () => {
      const { db, a } = seeded();
      const r = getIntroductionReport(db, { projectId: a }, MON + 20 * DAY);
      expect(r.outOfScope).toBe(false);
      expect(r.bugs).toHaveLength(1);
    });

    it('is empty and out of scope for a project on another repo, or on none', () => {
      const { db, b, c } = seeded();
      for (const projectId of [b, c]) {
        const r = getIntroductionReport(db, { projectId }, MON + 20 * DAY);
        expect(r).toMatchObject({ outOfScope: true, bugs: [], computedAt: 99 });
        expect(r.weeks.every((w) => w.prsMerged.robot + w.prsMerged.human === 0)).toBe(true);
      }
    });

    it('is unchanged without a filter', () => {
      const { db } = seeded();
      const r = getIntroductionReport(db, {}, MON + 20 * DAY);
      expect(r.outOfScope).toBe(false);
      expect(r.bugs).toHaveLength(1);
    });
  });
});
