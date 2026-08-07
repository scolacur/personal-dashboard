import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import type { JobRun } from '@dashboard/shared';
import { bootstrapJobRunsSchema, startRun, finishRun } from './job-runs';
import { registerJobRunRoutes } from './job-runs-routes';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapJobRunsSchema(db);
  app = Fastify({ logger: false });
  registerJobRunRoutes(app, db);
});

/** A closed `ok` run with a headline payload. */
function seedRun(jobName: string, startedAt: number, summary: Record<string, unknown> = {}) {
  const run = startRun(db, jobName, startedAt);
  return finishRun(db, run.id, { status: 'ok', summary }, startedAt + 5000);
}

describe('GET /api/jobs/:jobName/runs', () => {
  it('lists the job’s runs newest-first', async () => {
    seedRun('bst-scan', 100);
    seedRun('bst-scan', 300);
    seedRun('other-job', 200);

    const res = await app.inject({ method: 'GET', url: '/api/jobs/bst-scan/runs' });
    expect(res.statusCode).toBe(200);
    const runs = res.json() as JobRun[];
    expect(runs.map((r) => r.startedAt)).toEqual([300, 100]);
    expect(runs.every((r) => r.jobName === 'bst-scan')).toBe(true);
  });

  it('returns an empty array for an unknown job — not a 404', async () => {
    // A job registered in the UI that has never fired is a normal state, not an error.
    const res = await app.inject({ method: 'GET', url: '/api/jobs/never-ran/runs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('honours ?limit', async () => {
    for (let i = 0; i < 5; i++) seedRun('bst-scan', 100 + i);
    const res = await app.inject({ method: 'GET', url: '/api/jobs/bst-scan/runs?limit=2' });
    expect((res.json() as JobRun[]).map((r) => r.startedAt)).toEqual([104, 103]);
  });

  it('falls back to the default limit on a junk ?limit rather than 400ing', async () => {
    seedRun('bst-scan', 100);
    for (const limit of ['abc', '-1', '0', '']) {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/bst-scan/runs?limit=${limit}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    }
  });

  it('clamps an absurd ?limit', async () => {
    seedRun('bst-scan', 100);
    const res = await app.inject({ method: 'GET', url: '/api/jobs/bst-scan/runs?limit=999999' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/jobs/:jobName/runs/:runId', () => {
  it('returns the one run, summary parsed', async () => {
    const seeded = seedRun('bst-scan', 100, { scanned: 142, matched: 34 });
    const res = await app.inject({ method: 'GET', url: `/api/jobs/bst-scan/runs/${seeded!.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: seeded!.id,
      jobName: 'bst-scan',
      status: 'ok',
      summary: { scanned: 142, matched: 34 },
    });
  });

  it('404s cleanly on an unknown run id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/bst-scan/runs/4242' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Run not found' });
  });

  it('404s on a non-numeric run id instead of throwing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/bst-scan/runs/latest' });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the run exists but belongs to another job', async () => {
    // Run ids are global. Without the job-name check this would render another job's run under
    // this job's heading — the detail page trusts the route to have matched both.
    const seeded = seedRun('other-job', 100);
    const res = await app.inject({ method: 'GET', url: `/api/jobs/bst-scan/runs/${seeded!.id}` });
    expect(res.statusCode).toBe(404);
  });
});
