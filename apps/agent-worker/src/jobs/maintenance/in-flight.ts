import type Database from 'better-sqlite3';

/**
 * Robot runs currently in flight — the drain check the maintenance hold waits on.
 *
 * Lived in the decision-consolidation job until PD-560 deleted it, but it was never that job's:
 * draining is the *hold's* precondition, and any future maintenance job needs the same answer.
 *
 * A run counts only if its TICKET is also still `working`, which is the same definition
 * `orphanedRunningRuns` uses to decide what a live run is. `status = 'running'` alone is not enough:
 * the runs table accumulates rows that never got a terminal status, and nothing ever clears them.
 *
 * Found in production, not in a test: on 2026-08-22 the NAS DB held one `running` row from
 * 2026-07-16 whose ticket (PD-380) had been `completed` for five weeks with `agent_state` NULL. The
 * stall reconciler cannot close it — it only looks at runs whose ticket is `working` — so the row is
 * permanent. Counting it would have meant no hold ever opened.
 */
export function inFlightRunCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agent_runs r
         JOIN agent_tickets t ON t.id = r.ticket_id
        WHERE r.status = 'running'
          AND t.agent_state = 'working'`,
    )
    .get() as { n: number };
  return row.n;
}
