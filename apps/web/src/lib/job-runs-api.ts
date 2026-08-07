import type { JobRun } from '@dashboard/shared';

// Client for the generic job-run store (PD-442). Core routes, not widget routes — `job_runs` is
// shared infrastructure, so this sits under /api/jobs rather than any widget's namespace.

const BASE = '/api/jobs';

/** A job's runs, newest first. An unknown job name returns `[]` — never a 404. */
export async function fetchJobRuns(jobName: string, limit?: number): Promise<JobRun[]> {
  const query = limit != null ? `?limit=${limit}` : '';
  const res = await fetch(`${BASE}/${encodeURIComponent(jobName)}/runs${query}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<JobRun[]>;
}

/** One run. 404s if the id is unknown *or* belongs to a different job. */
export async function fetchJobRun(jobName: string, runId: number): Promise<JobRun> {
  const res = await fetch(`${BASE}/${encodeURIComponent(jobName)}/runs/${runId}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<JobRun>;
}
