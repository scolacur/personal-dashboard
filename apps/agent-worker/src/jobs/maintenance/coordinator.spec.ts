import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureRobotStateTable, maintenanceHold } from '../robot/state';
import { tick, type CoordinatorConfig, type CoordinatorDeps, type MaintenanceJobRunner } from './coordinator';
import { activeHold, nextQueuedHold, requestHold } from './holds-db';

const CONFIG: CoordinatorConfig = { cadenceMs: 86_400_000, windowMs: 1_800_000, drainTimeoutMs: 7_200_000 };

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureRobotStateTable(db);
  // Fixture copy of the web process's DDL (apps/server/src/lib/maintenance-holds.ts). The worker
  // never creates these tables in production either — see the note in holds-db.ts.
  db.exec(`
    CREATE TABLE maintenance_holds (id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, status TEXT NOT NULL,
      requested_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, note TEXT);
    CREATE TABLE maintenance_hold_runs (hold_id INTEGER NOT NULL, job_run_id INTEGER NOT NULL,
      PRIMARY KEY (hold_id, job_run_id));
    CREATE TABLE job_runs (id INTEGER PRIMARY KEY, job_name TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, status TEXT NOT NULL, summary TEXT, error TEXT);
    CREATE TABLE maintenance_job_requests (id INTEGER PRIMARY KEY, hold_id INTEGER NOT NULL,
      job_name TEXT NOT NULL, requested_at INTEGER NOT NULL, claimed_at INTEGER);
  `);
  return db;
}

interface Harness {
  deps: CoordinatorDeps;
  ran: string[];
  setInFlight: (n: number) => void;
  setNow: (t: number) => void;
}

function harness(opts: { inFlight?: number; now?: number; runner?: MaintenanceJobRunner } = {}): Harness {
  let inFlight = opts.inFlight ?? 0;
  let now = opts.now ?? 1_000_000;
  const ran: string[] = [];
  const runner: MaintenanceJobRunner =
    opts.runner ??
    (async (db) => {
      ran.push('decisions:consolidation');
      const info = db
        .prepare("INSERT INTO job_runs (job_name, started_at, status) VALUES ('decisions:consolidation', ?, 'ok')")
        .run(now);
      return Number(info.lastInsertRowid);
    });
  return {
    ran,
    deps: {
      inFlightRuns: () => inFlight,
      now: () => now,
      jobs: new Map([['decisions:consolidation', runner]]),
    },
    setInFlight: (n) => {
      inFlight = n;
    },
    setNow: (t) => {
      now = t;
    },
  };
}

describe('maintenance coordinator', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('opens a scheduled hold when the daily cadence comes due', async () => {
    const h = harness();
    await tick(db, CONFIG, h.deps);
    // With nothing in flight the whole thing happens in one tick: queued, started, jobs run, closed.
    // So assert the RECORD, not a still-open window — see 'closes a scheduled hold immediately'.
    const row = db.prepare('SELECT trigger, status, started_at FROM maintenance_holds').get() as {
      trigger: string;
      status: string;
      started_at: number | null;
    };
    expect(row).toMatchObject({ trigger: 'scheduled', status: 'completed' });
    expect(row.started_at).not.toBeNull();
    expect(h.ran).toEqual(['decisions:consolidation']);
  });

  it('does not queue a second hold while one is already pending or open', async () => {
    const h = harness({ inFlight: 1 }); // stays queued
    await tick(db, CONFIG, h.deps);
    await tick(db, CONFIG, h.deps);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM maintenance_holds').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('measures the cadence from the last hold that STARTED, not the last requested', async () => {
    // A hold that sat queued for hours has not done its rounds; counting it would skip a day.
    const h = harness();
    await tick(db, CONFIG, h.deps); // opens and (scheduled) closes
    h.setNow(1_000_000 + CONFIG.cadenceMs - 1);
    await tick(db, CONFIG, h.deps);
    expect(nextQueuedHold(db)).toBeNull(); // not yet due

    h.setNow(1_000_000 + CONFIG.cadenceMs + 1);
    await tick(db, CONFIG, h.deps);
    expect(h.ran.length).toBe(2);
  });

  it('holds dispatch before draining, so the queue cannot refill behind it', async () => {
    const h = harness({ inFlight: 2 });
    await tick(db, CONFIG, h.deps);
    expect(maintenanceHold(db)).not.toBeNull(); // held
    expect(activeHold(db)).toBeNull(); // but not open yet — still draining
    expect(h.ran).toEqual([]);
  });

  it('opens the window and runs its jobs once runs drain', async () => {
    const h = harness({ inFlight: 2 });
    await tick(db, CONFIG, h.deps);
    h.setInFlight(0);
    await tick(db, CONFIG, h.deps);
    expect(h.ran).toEqual(['decisions:consolidation']);
  });

  it('abandons the hold and releases dispatch when the drain never finishes', async () => {
    const h = harness({ inFlight: 2 });
    await tick(db, CONFIG, h.deps);
    h.setNow(1_000_000 + CONFIG.drainTimeoutMs + 1);
    await tick(db, CONFIG, h.deps);

    const row = db.prepare('SELECT status, note FROM maintenance_holds').get() as { status: string; note: string };
    expect(row.status).toBe('abandoned');
    expect(row.note).toContain('never drained');
    expect(maintenanceHold(db)).toBeNull(); // dispatch given back
  });

  it('closes a scheduled hold immediately rather than sitting on dispatch', async () => {
    const h = harness();
    await tick(db, CONFIG, h.deps);
    expect(activeHold(db)).toBeNull();
    expect(maintenanceHold(db)).toBeNull();
    const row = db.prepare('SELECT status FROM maintenance_holds').get() as { status: string };
    expect(row.status).toBe('completed');
  });

  it('keeps a MANUAL hold open for the window — Run now needs something to run inside', async () => {
    const h = harness();
    requestHold(db, 'manual', 999_999);
    await tick(db, CONFIG, h.deps);
    expect(activeHold(db)).not.toBeNull();
    expect(maintenanceHold(db)).not.toBeNull();
    expect(h.ran).toEqual(['decisions:consolidation']);
  });

  it('closes a manual hold when its window elapses', async () => {
    const h = harness();
    requestHold(db, 'manual', 999_999);
    await tick(db, CONFIG, h.deps);
    h.setNow(1_000_000 + CONFIG.windowMs + 1);
    await tick(db, CONFIG, h.deps);
    expect(activeHold(db)).toBeNull();
    expect(maintenanceHold(db)).toBeNull();
  });

  it('runs an on-demand request inside an open window', async () => {
    const h = harness();
    requestHold(db, 'manual', 999_999);
    await tick(db, CONFIG, h.deps); // opens, runs its rounds
    const hold = activeHold(db)!;
    db.prepare('INSERT INTO maintenance_job_requests (hold_id, job_name, requested_at) VALUES (?, ?, ?)').run(
      hold.id,
      'decisions:consolidation',
      1_000_001,
    );
    await tick(db, CONFIG, h.deps);
    expect(h.ran).toEqual(['decisions:consolidation', 'decisions:consolidation']);
  });

  it('claims an on-demand request so a second tick cannot double-run it', async () => {
    const h = harness();
    requestHold(db, 'manual', 999_999);
    await tick(db, CONFIG, h.deps);
    const hold = activeHold(db)!;
    db.prepare('INSERT INTO maintenance_job_requests (hold_id, job_name, requested_at) VALUES (?, ?, ?)').run(
      hold.id,
      'decisions:consolidation',
      1_000_001,
    );
    await tick(db, CONFIG, h.deps);
    await tick(db, CONFIG, h.deps);
    expect(h.ran.length).toBe(2); // the rounds + one on-demand, not two
  });

  it('attaches each job run to the hold, so the log can show what ran inside it', async () => {
    const h = harness();
    await tick(db, CONFIG, h.deps);
    const row = db.prepare('SELECT COUNT(*) AS n FROM maintenance_hold_runs').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('a job that throws does not strand the hold', async () => {
    const h = harness({
      runner: async () => {
        throw new Error('consolidation blew up');
      },
    });
    await tick(db, CONFIG, h.deps);
    // The window still closed and dispatch still came back.
    expect(maintenanceHold(db)).toBeNull();
    const row = db.prepare('SELECT status FROM maintenance_holds').get() as { status: string };
    expect(row.status).toBe('completed');
  });

  it('a job that records no run leaves no dangling log entry', async () => {
    const h = harness({ runner: async () => null });
    await tick(db, CONFIG, h.deps);
    const row = db.prepare('SELECT COUNT(*) AS n FROM maintenance_hold_runs').get() as { n: number };
    expect(row.n).toBe(0);
  });
});
