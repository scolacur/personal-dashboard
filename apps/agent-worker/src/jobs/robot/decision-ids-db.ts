import type Database from 'better-sqlite3';

/**
 * The worker's half of the decision-id counter (PD-564; the counter itself is PD-557).
 *
 * **The schema is owned and bootstrapped by the web process**, in
 * `apps/server/src/lib/decision-ids.ts`. This file deliberately does not re-declare the DDL and
 * deliberately does not seed — two `CREATE TABLE IF NOT EXISTS` for one table is a drift bug
 * waiting to happen, and a second seeder could rewind the counter and re-issue live ids. If the
 * worker boots first, {@link decisionCounterReady} is false and the tool refuses with guidance
 * rather than inventing a counter it cannot know is at the right number.
 *
 * Same split the maintenance holds already use (`jobs/maintenance/holds-db.ts`) and `robot_state`
 * before them: each process writes its own SQL against a shared DB, neither imports the other.
 *
 * ## This is where cross-process atomicity stops being theoretical
 *
 * With this file there are two processes allocating against one `dashboard.db` — the web process
 * serving `POST /api/decisions/allocate` for human authors, and this one serving Robots. A
 * read-then-write would now genuinely race, not merely look wrong. The single `UPDATE … RETURNING`
 * below is the same statement the server uses, for the same reason: SQLite wraps one statement in
 * its own transaction, so two processes can never observe the same `last_num`.
 */

/** Whether the web process has created the counter yet. */
export function decisionCounterReady(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'decision_id_counter'")
    .get() as { n: number };
  return row.n === 1;
}

/**
 * Take the next decision id, atomically. Returns `null` if the counter does not exist yet.
 *
 * Never returns a number it has returned before, whether or not the caller ends up using it. An id
 * taken for a decision that is never written simply leaves a gap, which is harmless — see the
 * server-side module docs for why there is no reclaim path.
 */
export function allocateDecisionId(db: Database.Database): string | null {
  if (!decisionCounterReady(db)) return null;

  const row = db
    .prepare('UPDATE decision_id_counter SET last_num = last_num + 1 WHERE id = 1 RETURNING last_num')
    .get() as { last_num: number } | undefined;

  // The table exists but holds no row — the server creates the table and its single row together,
  // so this means something truncated it. Not something to paper over by seeding.
  if (!row) return null;

  return `D-${String(row.last_num).padStart(3, '0')}`;
}
