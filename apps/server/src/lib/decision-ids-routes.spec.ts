import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { HIGHEST_DECISION_AT_SEED, bootstrapDecisionIdsSchema, formatDecisionId } from './decision-ids';
import { registerDecisionIdRoutes } from './decision-ids-routes';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapDecisionIdsSchema(db);
  app = Fastify({ logger: false });
  registerDecisionIdRoutes(app, db);
});

describe('POST /api/decisions/allocate', () => {
  it('returns the next decision id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/decisions/allocate' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: formatDecisionId(HIGHEST_DECISION_AT_SEED + 1) });
  });

  /**
   * Twenty requests, twenty distinct ids — the property the endpoint exists for.
   *
   * **This does not prove atomicity, and no test in this process can.** better-sqlite3 is
   * synchronous, so a handler runs to completion before the next one starts and there is no point
   * at which two callers could interleave: a deliberately broken read-then-write implementation
   * passes this test too (verified by mutating the store while writing it). What this pins down is
   * that every call consumes exactly one id and none is served twice — which is what would break if
   * someone made the endpoint idempotent, cached it, or reset the counter per request.
   *
   * Atomicity itself is a cross-process property, and it is bought structurally rather than by
   * test: allocation is a single `UPDATE … RETURNING`, and allocation only ever happens here.
   */
  it('serves twenty requests twenty distinct ids', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: 'POST', url: '/api/decisions/allocate' })),
    );
    expect(new Set(results.map((r) => r.json().id as string)).size).toBe(20);
  });

  it('is not reachable by GET — allocation is a mutation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/decisions/allocate' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/decisions/next', () => {
  it('reports the next id without consuming it', async () => {
    const peek = await app.inject({ method: 'GET', url: '/api/decisions/next' });
    expect(peek.statusCode).toBe(200);
    expect(peek.json().next).toBe(formatDecisionId(HIGHEST_DECISION_AT_SEED + 1));

    const again = await app.inject({ method: 'GET', url: '/api/decisions/next' });
    expect(again.json().next).toBe(peek.json().next);

    const taken = await app.inject({ method: 'POST', url: '/api/decisions/allocate' });
    expect(taken.json().id).toBe(peek.json().next);
  });
});
