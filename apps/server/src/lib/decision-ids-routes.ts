import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { allocateDecisionId, peekNextDecisionId } from './decision-ids';

/**
 * Decision-id allocation endpoint (PD-557).
 *
 * A core route, mounted at `/api/decisions/...` beside `/api/jobs` and `/api/maintenance` — the
 * decision log is shared project infrastructure, not a widget.
 *
 * This is the one thing files cannot do: hand two concurrent authors different numbers. Everything
 * else about a decision — its content, its history, its citations — stays in git.
 */
export function registerDecisionIdRoutes(app: FastifyInstance, db: Database.Database): void {
  /**
   * Take the next `D-NNN`.
   *
   * **POST, not GET, precisely because it mutates.** A GET reading "next = 86" served to two
   * callers at the same moment reproduces the collision this endpoint exists to remove, and a GET
   * that quietly incremented would be a lie that caches and retries would eventually punish.
   *
   * The id is consumed the instant it is returned. If the caller abandons the decision the number
   * is simply never used — see the module docs on why there is no reclaim path.
   */
  app.post('/api/decisions/allocate', async () => ({ id: allocateDecisionId(db) }));

  /**
   * What the next allocation *would* be, without taking it.
   *
   * For status surfaces and for a human confirming the counter is where they expect after the
   * cutover (PD-560). Never allocate by reading this and adding one — that is the race.
   */
  app.get('/api/decisions/next', async () => ({ next: peekNextDecisionId(db) }));
}
