import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { MAINTENANCE_JOBS } from '@dashboard/shared';
import { activeHold, listHolds, nextQueuedHold, requestHold } from './maintenance-holds';
import { requestMaintenanceJobRun } from './maintenance-job-requests';

/**
 * Maintenance-hold endpoints (PD-498).
 *
 * Core routes, mounted at `/api/maintenance/...` beside `/api/jobs` — the hold is shared
 * infrastructure over the Robot loop, not a widget's concern.
 *
 * Every write here is a **request**, never an action: the web process cannot drain Robot runs, so
 * it inserts a row and the agent-worker acts on it. Same DB-as-the-queue split the loop uses.
 */
export function registerMaintenanceRoutes(app: FastifyInstance, db: Database.Database): void {
  /** The status strip + nav indicator read this. */
  app.get('/api/maintenance/status', async () => {
    const active = activeHold(db);
    return { active, queued: active ? null : nextQueuedHold(db), jobs: MAINTENANCE_JOBS };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/maintenance/holds', async (req) => {
    const n = Number(req.query.limit);
    return listHolds(db, Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 20);
  });

  /**
   * Start a hold, or queue one for when Robot runs drain.
   *
   * Returns the hold plus `immediate`, which is what the UI reports back: "held now" versus
   * "queued until the current runs finish". A hold that is already active is returned as-is rather
   * than queueing a second one behind it — the caller wanted a window, and there is one open.
   */
  app.post('/api/maintenance/holds', async (_req, reply) => {
    const active = activeHold(db);
    if (active) return reply.send({ hold: active, immediate: true, joined: true });
    const hold = requestHold(db, 'manual');
    return reply.send({ hold, immediate: false, joined: false });
  });

  /**
   * Run one maintenance job inside the open hold.
   *
   * Refused with 409 when no hold is active, which is the server-side half of the disabled button:
   * the UI greys it out, and this makes the rule true rather than merely displayed. Running these
   * jobs outside a hold is exactly what the hold exists to prevent.
   */
  app.post<{ Params: { jobName: string } }>('/api/maintenance/jobs/:jobName/run', async (req, reply) => {
    const job = MAINTENANCE_JOBS.find((j) => j.jobName === req.params.jobName);
    if (!job) return reply.status(404).send({ error: 'unknown maintenance job', code: 'UNKNOWN_JOB' });

    const active = activeHold(db);
    if (!active) {
      return reply.status(409).send({
        error: 'a maintenance job can only run during an active maintenance hold',
        code: 'NO_ACTIVE_HOLD',
      });
    }

    requestMaintenanceJobRun(db, active.id, job.jobName);
    return reply.send({ requested: true, holdId: active.id, jobName: job.jobName });
  });
}
