import type { JobRun, JobRunStatus } from '@dashboard/shared';
import type { RecurringJob } from './jobs';

// Display metadata + formatting for the generic job-run surfaces (PD-442). Pure functions only,
// mirroring how audit-display.ts sits beside audit-logic.ts — the component imports from here so
// the formatting is unit-testable without mounting anything.

const STATUS_LABELS: Record<JobRunStatus, string> = {
  running: 'Running',
  ok: 'OK',
  error: 'Error',
  partial: 'Partial',
  interrupted: 'Interrupted',
};

export function runStatusLabel(status: JobRunStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// Neither `partial` nor `interrupted` gets the red `error` uses. A run cut short by a deploy is
// an unknown outcome and a partial run did real work — colouring either red would make every
// restart, and every half-readable week, look like breakage. Neither gets neutral grey either:
// grey reads as "nothing happened", and in both cases something did.
const STATUS_COLORS: Record<JobRunStatus, string> = {
  running: 'var(--status-working)',
  ok: 'var(--status-done)',
  error: 'var(--status-stuck)',
  partial: 'var(--status-needs-human)',
  interrupted: 'var(--status-warn)',
};

export function runStatusColor(status: JobRunStatus): string {
  return STATUS_COLORS[status] ?? 'var(--muted)';
}

/** ms → `12s` / `3m 5s` / `1h 4m`. Sub-second rounds up to `1s` — `0s` reads as "didn't run". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/**
 * How long a run took, or null when that is unknowable.
 *
 * Two cases return null and the caller renders "—":
 *
 * - **Still in flight.** A live-ticking elapsed time that only updates when the poll happens to
 *   fire is worse than no number.
 * - **`interrupted`.** Its `finishedAt` is when the restart was *detected*, not when the work
 *   stopped. A run interrupted on Monday and swept on Thursday would otherwise report "3d",
 *   which is a confident lie sitting next to a message saying we don't know what happened.
 */
export function runDuration(run: JobRun): string | null {
  if (run.finishedAt === null || run.status === 'interrupted') return null;
  return formatDuration(run.finishedAt - run.startedAt);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "4 minutes ago" / "3 days ago", falling back to an absolute date past a month.
 *
 * The run surfaces answer "did this run recently?", and a relative time answers it at a glance in
 * a way a timestamp does not. Past ~30 days the relative form stops being informative, so it
 * hands over to the locale date.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  // A clock skew or a scheduled-in-the-future timestamp shouldn't render as "-3 minutes ago".
  if (delta < 45_000) return 'just now';
  if (delta < HOUR) return plural(Math.round(delta / MINUTE), 'minute');
  if (delta < DAY) return plural(Math.round(delta / HOUR), 'hour');
  if (delta < 30 * DAY) return plural(Math.round(delta / DAY), 'day');
  return new Date(ts).toLocaleDateString();
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * What a run's closing timestamp actually means.
 *
 * For an `interrupted` run it is when the restart was noticed, not when the job stopped — so the
 * detail page says "detected" rather than claiming a finish time it does not have.
 */
export function endTimeLabel(status: JobRunStatus): string {
  return status === 'interrupted' ? 'detected' : 'finished';
}

/**
 * Heading for the callout carrying `run.error`.
 *
 * Only `error` is a failure. An interruption and a partial run both ended badly enough to
 * explain themselves, but calling either one "Failure" is the mislabelling these statuses exist
 * to prevent.
 */
export function outcomeLabel(status: JobRunStatus): string {
  if (status === 'interrupted') return 'Interrupted';
  if (status === 'partial') return 'Incomplete';
  return 'Failure';
}

/** Unix-ms → local wall-clock string. Matches audit-display's `formatTs`. */
export function formatTs(ts: number | null): string {
  return ts === null ? '—' : new Date(ts).toLocaleString();
}

/** The generic run-detail route for a job. */
export function genericRunDetailPath(jobName: string, runId: number): string {
  return `/devops/jobs/${encodeURIComponent(jobName)}/${runId}`;
}

/**
 * Where a run's "view detail" link points.
 *
 * A job may register its own richer report page (`runs.detailHref`) — that is how the Ticket
 * Audit keeps its findings report once it moves onto this store. Everything else gets the
 * generic route, which is the whole point: run history by registering, not by building.
 */
export function runDetailPath(job: RecurringJob, runId: number): string | null {
  if (!job.runs) return null;
  return job.runs.detailHref?.(runId) ?? genericRunDetailPath(job.runs.jobName, runId);
}

/**
 * The fallback headline for a run whose job supplied no custom renderer.
 *
 * Renders the summary's own key/value pairs rather than inventing labels, because the store is
 * deliberately blind to what a job's numbers mean. Nested objects are dropped — they belong on
 * the detail page, not in a one-line row.
 */
export function defaultHeadline(run: JobRun): string {
  if (run.status === 'error') return run.error ?? 'Failed';
  if (run.status === 'interrupted') return run.error ?? 'Interrupted before it finished';
  // A partial run leads with what went wrong, not with the numbers it did manage — the numbers
  // are the half that worked, and showing them alone is how a degrading job looks healthy.
  if (run.status === 'partial') return run.error ?? 'Completed only partly';
  if (run.status === 'running') return 'In progress…';
  if (!run.summary) return 'No details recorded';

  const parts = Object.entries(run.summary)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
    .map(([k, v]) => `${humanizeKey(k)}: ${v}`);

  return parts.length > 0 ? parts.join(' · ') : 'No details recorded';
}

/** `threadsRead` / `threads_read` → `Threads read`. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
