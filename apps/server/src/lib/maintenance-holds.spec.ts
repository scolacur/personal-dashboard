import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapJobRunsSchema } from './job-runs';
import {
  activeHold,
  attachRunToHold,
  bootstrapMaintenanceHoldsSchema,
  closeStaleHolds,
  endHold,
  getMaintenanceHoldStatus,
  lastHoldStartedAt,
  listHolds,
  nextQueuedHold,
  requestHold,
  startHold,
} from './maintenance-holds';
import { bootstrapMaintenanceJobRequestsSchema, claimMaintenanceJobRun, requestMaintenanceJobRun } from './maintenance-job-requests';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  bootstrapJobRunsSchema(db);
  bootstrapMaintenanceHoldsSchema(db);
  bootstrapMaintenanceJobRequestsSchema(db);
  return db;
}

describe('maintenance hold store', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('starts with nothing', () => {
    expect(activeHold(db)).toBeNull();
    expect(nextQueuedHold(db)).toBeNull();
    expect(listHolds(db)).toEqual([]);
  });

  it('queues a request, which the worker later starts and ends', () => {
    const queued = requestHold(db, 'manual', 1000);
    expect(queued.status).toBe('queued');
    expect(activeHold(db)).toBeNull();

    startHold(db, queued.id, 2000);
    expect(activeHold(db)?.id).toBe(queued.id);

    endHold(db, queued.id, 'completed', null, 5000);
    expect(activeHold(db)).toBeNull();
  });

  it('does not stack duplicate requests — pressing twice means one hold', () => {
    const a = requestHold(db, 'manual', 1000);
    const b = requestHold(db, 'manual', 1001);
    expect(b.id).toBe(a.id);
    expect(listHolds(db)).toHaveLength(1);
  });

  it('measures the cadence from the last START, so time spent queued does not count', () => {
    const h = requestHold(db, 'scheduled', 1000);
    expect(lastHoldStartedAt(db)).toBeNull(); // queued but never started
    startHold(db, h.id, 9000);
    expect(lastHoldStartedAt(db)).toBe(9000);
  });

  it('lists holds newest first with the runs that happened inside them', () => {
    const h = requestHold(db, 'manual', 1000);
    startHold(db, h.id, 2000);
    const runId = Number(
      db.prepare("INSERT INTO job_runs (job_name, started_at, status) VALUES ('decisions:consolidation', 2100, 'ok')").run()
        .lastInsertRowid,
    );
    attachRunToHold(db, h.id, runId);
    endHold(db, h.id, 'completed', null, 3000);

    const [logged] = listHolds(db);
    expect(logged.runs).toHaveLength(1);
    expect(logged.runs[0]).toMatchObject({ jobRunId: runId, jobName: 'decisions:consolidation', status: 'ok' });
  });

  it('records why a hold was abandoned', () => {
    const h = requestHold(db, 'scheduled', 1000);
    endHold(db, h.id, 'abandoned', '2 run(s) never drained', 3000);
    expect(listHolds(db)[0]).toMatchObject({ status: 'abandoned', note: '2 run(s) never drained' });
  });

  it('closes a hold the worker died inside, so the nav stops claiming one is open', () => {
    const h = requestHold(db, 'manual', 1000);
    startHold(db, h.id, 2000);
    // Window long past: the worker's own hold state has lapsed, so this row is lying.
    expect(closeStaleHolds(db, 60_000, 2000 + 60_001)).toBe(1);
    expect(activeHold(db)).toBeNull();
  });

  it('leaves a hold that is still inside its window alone', () => {
    const h = requestHold(db, 'manual', 1000);
    startHold(db, h.id, 2000);
    expect(closeStaleHolds(db, 60_000, 2500)).toBe(0);
    expect(activeHold(db)?.id).toBe(h.id);
  });
});

describe('maintenance job requests', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('is idempotent while unclaimed — two presses in one window is one run', () => {
    const a = requestMaintenanceJobRun(db, 1, 'decisions:consolidation', 100);
    const b = requestMaintenanceJobRun(db, 1, 'decisions:consolidation', 200);
    expect(b.id).toBe(a.id);
  });

  it('allows a fresh request once the previous one has been claimed', () => {
    requestMaintenanceJobRun(db, 1, 'decisions:consolidation', 100);
    claimMaintenanceJobRun(db, 1, 150);
    const again = requestMaintenanceJobRun(db, 1, 'decisions:consolidation', 200);
    expect(again.claimedAt).toBeNull();
  });

  it('claims at most once, so two ticks cannot double-run a job', () => {
    requestMaintenanceJobRun(db, 1, 'decisions:consolidation', 100);
    expect(claimMaintenanceJobRun(db, 1, 150)).not.toBeNull();
    expect(claimMaintenanceJobRun(db, 1, 160)).toBeNull();
  });

  it('keeps requests scoped to their hold', () => {
    requestMaintenanceJobRun(db, 1, 'decisions:consolidation', 100);
    expect(claimMaintenanceJobRun(db, 2, 150)).toBeNull();
  });
});

// PD-498. `SystemStatus.maintenanceHold` is the ONLY channel by which the nav and the board learn
// that dispatch has stopped for maintenance. Anything it omits, they contradict.
describe('getMaintenanceHoldStatus — what the nav is allowed to see', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  const WINDOW = 30 * 60_000;

  it('is null when nothing is holding', () => {
    expect(getMaintenanceHoldStatus(db, WINDOW)).toBeNull();
  });

  it('reports an open window with a deadline computed from the shared constant', () => {
    const h = requestHold(db, 'manual', 1000);
    startHold(db, h.id, 2000);
    expect(getMaintenanceHoldStatus(db, WINDOW)).toMatchObject({
      phase: 'active',
      trigger: 'manual',
      startedAt: 2000,
      endsBy: 2000 + WINDOW,
    });
  });

  // The drain lasts as long as the longest run in flight, and dispatch is already refused
  // throughout it. Reporting only open windows left the nav saying "Loop on" for that whole span.
  it('reports a QUEUED hold, because dispatch is already stopped', () => {
    requestHold(db, 'scheduled', 1000);
    expect(getMaintenanceHoldStatus(db, WINDOW)).toMatchObject({ phase: 'queued', trigger: 'scheduled' });
  });

  it('gives a queued hold no deadline — its window has not started', () => {
    requestHold(db, 'scheduled', 1000);
    const status = getMaintenanceHoldStatus(db, WINDOW)!;
    expect(status.startedAt).toBeNull();
    expect(status.endsBy).toBeNull();
  });

  it('prefers the open window when a hold is queued behind one', () => {
    const open = requestHold(db, 'manual', 1000);
    startHold(db, open.id, 2000);
    requestHold(db, 'scheduled', 3000);
    expect(getMaintenanceHoldStatus(db, WINDOW)).toMatchObject({ id: open.id, phase: 'active' });
  });

  it('goes back to null once the hold ends', () => {
    const h = requestHold(db, 'manual', 1000);
    startHold(db, h.id, 2000);
    endHold(db, h.id, 'completed', null, 3000);
    expect(getMaintenanceHoldStatus(db, WINDOW)).toBeNull();
  });
});
