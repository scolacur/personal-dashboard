import type Database from 'better-sqlite3';
import type { JobRun, JobRunStatus, JobRunSummary } from '@dashboard/shared';

/**
 * Generic job-run store (PD-442).
 *
 * Cross-widget infrastructure, so it lives in `apps/server/src/lib/` rather than inside any one
 * widget (PROJECT.md §5). A scheduled job wraps its work in `recordRun` and gets a durable
 * record — did it run, did it work, what did it find — plus the run surfaces that read it, with
 * no new UI code.
 *
 * The pattern is lifted from the Ticket Audit's `audit_run` table, which is the good version of
 * this and stays where it is; migrating it here is its own ticket (PD-443).
 *
 * `summary` is a job-defined JSON blob and the store never inspects it. That is what lets one
 * table serve a Reddit scan, a post drafter and a DB backup without growing a column per job.
 */

interface JobRunRow {
  id: number;
  job_name: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  summary: string | null;
  error: string | null;
}

function rowToRun(r: JobRunRow): JobRun {
  return {
    id: r.id,
    jobName: r.job_name,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as JobRunStatus,
    summary: r.summary ? (JSON.parse(r.summary) as JobRunSummary) : null,
    error: r.error,
  };
}

export function bootstrapJobRunsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id          INTEGER PRIMARY KEY,
      job_name    TEXT    NOT NULL,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      status      TEXT    NOT NULL,
      summary     TEXT,
      error       TEXT
    );

    /* Every read is "this job's runs, newest first". */
    CREATE INDEX IF NOT EXISTS idx_job_runs_name_started
      ON job_runs (job_name, started_at DESC);
  `);

  closeInterruptedRuns(db);
}

/**
 * Close any run still marked `running` at boot.
 *
 * Jobs run in-process on `node-cron`, so a `running` row at startup cannot belong to a live run —
 * it belongs to a process that died mid-job. Left alone it renders as a spinner that never
 * resolves, which reads as "still working" forever. Recording it as an error that says what
 * happened is the honest version, and it is the same principle as the BST scan's three-valued
 * status: never present an unknown outcome as a clean one.
 */
function closeInterruptedRuns(db: Database.Database): void {
  db.prepare(
    `UPDATE job_runs
        SET status = 'error',
            finished_at = ?,
            error = 'interrupted — the server restarted while this run was in flight'
      WHERE status = 'running'`,
  ).run(Date.now());
}

export function startRun(db: Database.Database, jobName: string, now = Date.now()): JobRun {
  const res = db
    .prepare("INSERT INTO job_runs (job_name, started_at, status) VALUES (?, ?, 'running')")
    .run(jobName, now);
  const row = db
    .prepare('SELECT * FROM job_runs WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as JobRunRow;
  return rowToRun(row);
}

export interface FinishRunInput {
  status: Exclude<JobRunStatus, 'running'>;
  summary?: JobRunSummary | null;
  error?: string | null;
}

export function finishRun(
  db: Database.Database,
  id: number,
  input: FinishRunInput,
  now = Date.now(),
): JobRun | null {
  db.prepare(
    'UPDATE job_runs SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ?',
  ).run(
    input.status,
    now,
    input.summary == null ? null : JSON.stringify(input.summary),
    input.error ?? null,
    id,
  );
  return getRun(db, id);
}

/** A job's runs, newest first. `limit` caps the list for the overview surfaces. */
export function listRuns(db: Database.Database, jobName: string, limit?: number): JobRun[] {
  const rows = (
    limit == null
      ? db.prepare('SELECT * FROM job_runs WHERE job_name = ? ORDER BY started_at DESC, id DESC')
          .all(jobName)
      : db
          .prepare(
            'SELECT * FROM job_runs WHERE job_name = ? ORDER BY started_at DESC, id DESC LIMIT ?',
          )
          .all(jobName, limit)
  ) as JobRunRow[];
  return rows.map(rowToRun);
}

export function getRun(db: Database.Database, id: number): JobRun | null {
  const row = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as JobRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export interface JobRunContext {
  runId: number;
  /**
   * Attach this run's headline numbers. Last call wins.
   *
   * Called from inside the work, where the numbers actually are — a summary computed by a
   * separate callback afterwards can only see the return value, which is the wrong shape for a
   * job that partly succeeded.
   */
  setSummary(summary: JobRunSummary): void;
}

/**
 * Wrap a job's work in a run record: opens a `running` row, closes it `ok` or `error`.
 *
 * A throw is recorded and **rethrown** — `CronRegistry` already logs and swallows job failures,
 * and swallowing it here as well would make a broken job look like a job that never fired. The
 * run row is written before the rethrow, so the failure is visible in the UI either way.
 */
export async function recordRun<T>(
  db: Database.Database,
  jobName: string,
  work: (ctx: JobRunContext) => Promise<T> | T,
): Promise<T> {
  const run = startRun(db, jobName);
  let summary: JobRunSummary | null = null;

  try {
    const result = await work({
      runId: run.id,
      setSummary: (s) => {
        summary = s;
      },
    });
    finishRun(db, run.id, { status: 'ok', summary });
    return result;
  } catch (e) {
    // The summary is kept even on failure: a job that scanned two threads and then threw knows
    // more than a bare error message does.
    finishRun(db, run.id, {
      status: 'error',
      summary,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
