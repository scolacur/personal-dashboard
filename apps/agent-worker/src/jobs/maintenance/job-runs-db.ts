import type Database from 'better-sqlite3';

/**
 * The worker's writer for the shared `job_runs` store (PD-442 / D-074).
 *
 * The store itself and its schema live in `apps/server/src/lib/job-runs.ts`; this is the same
 * two-processes-one-DB split as `holds-db.ts`, and the same reason: a maintenance job runs in the
 * worker but has to show up on the Dev Ops Jobs page, which reads `job_runs`.
 *
 * Writing here is what earns the Decision Consolidation job its run list and its detail page with
 * no new UI code — the registry declaration plus these rows is the whole integration.
 */

/** Open a run. Returns the `job_runs.id`, which the hold log links against. */
export function startJobRun(db: Database.Database, jobName: string, now: number = Date.now()): number {
  const info = db
    .prepare("INSERT INTO job_runs (job_name, started_at, status) VALUES (?, ?, 'running')")
    .run(jobName, now);
  return Number(info.lastInsertRowid);
}

/**
 * Close a run. `summary` is a job-defined blob the store never inspects — that opacity is what lets
 * one table serve a Reddit scan and a decision renumbering without growing a column for each.
 */
export function finishJobRun(
  db: Database.Database,
  runId: number,
  status: 'ok' | 'error' | 'skipped',
  summary: unknown,
  error: string | null = null,
  now: number = Date.now(),
): void {
  db.prepare('UPDATE job_runs SET finished_at = ?, status = ?, summary = ?, error = ? WHERE id = ?').run(
    now,
    status,
    summary === undefined || summary === null ? null : JSON.stringify(summary),
    error,
    runId,
  );
}
