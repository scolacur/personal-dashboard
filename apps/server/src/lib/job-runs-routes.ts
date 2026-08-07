import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getRun, listRuns } from './job-runs';

/**
 * Read endpoints for the generic job-run store (PD-442).
 *
 * Core routes rather than widget routes — `job_runs` is shared infrastructure, so these mount at
 * `/api/jobs/...` and are registered from index.ts alongside `/api/health`.
 *
 * Read-only on purpose: triggering, cancelling and retrying runs from the UI is explicitly out of
 * scope. The one job with a "Run now" button (the Ticket Audit) enqueues through its own route.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/** A `limit` query param, clamped. A junk value falls back to the default rather than 400ing —
 *  this is a read surface, and refusing to show run history over a bad query string helps nobody. */
function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function registerJobRunRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get<{ Params: { jobName: string }; Querystring: { limit?: string } }>(
    '/api/jobs/:jobName/runs',
    async (req) => listRuns(db, req.params.jobName, parseLimit(req.query.limit)),
  );

  app.get<{ Params: { jobName: string; runId: string } }>(
    '/api/jobs/:jobName/runs/:runId',
    async (req, reply) => {
      const id = Number(req.params.runId);
      if (!Number.isInteger(id)) {
        return reply.status(404).send({ error: 'Run not found', code: 'RUN_NOT_FOUND' });
      }

      const run = getRun(db, id);
      // The job name is part of the identity, not decoration: /api/jobs/db-backup/runs/7 must not
      // serve run 7 of the ticket audit. Ids are global, so without this check the detail page
      // would happily render another job's run under this job's heading.
      if (!run || run.jobName !== req.params.jobName) {
        return reply.status(404).send({ error: 'Run not found', code: 'RUN_NOT_FOUND' });
      }

      return run;
    },
  );
}
