import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export const BASE = '/api/widgets/e2e-canary';

/**
 * The baseline: one liveness route. Everything else is added by E2E loop test tickets (PD-892)
 * and removed again when the test resets, so keep this file minimal: the reset restores it to this state.
 */
export function registerRoutes(app: FastifyInstance, _db: Database.Database): void {
  app.get(`${BASE}/health`, async () => ({ ok: true }));
}
