import { describe, it, expect } from 'vitest';
import type { JobRun } from '@dashboard/shared';
import { JOB_RUN_STATUSES, isRunFailure } from '@dashboard/shared';
import type { RecurringJob } from './jobs';
import {
  defaultHeadline,
  endTimeLabel,
  formatDuration,
  genericRunDetailPath,
  humanizeKey,
  outcomeLabel,
  relativeTime,
  runDetailPath,
  runDuration,
  runStatusColor,
  runStatusLabel,
} from './job-runs-display';

function run(over: Partial<JobRun> = {}): JobRun {
  return {
    id: 1,
    jobName: 'bst-scan',
    startedAt: 1_000_000,
    finishedAt: 1_005_000,
    status: 'ok',
    summary: null,
    error: null,
    ...over,
  };
}

function job(over: Partial<RecurringJob> = {}): RecurringJob {
  return {
    id: 'bst-scan',
    name: 'BST Scan',
    description: 'Weekly r/modular scan.',
    schedule: '0 9 * * 1',
    kind: 'backup',
    ...over,
  };
}

describe('status display', () => {
  it('labels and colours every status distinctly', () => {
    expect(JOB_RUN_STATUSES.map(runStatusLabel)).toEqual([
      'Running',
      'OK',
      'Error',
      'Interrupted',
    ]);
    expect(new Set(JOB_RUN_STATUSES.map(runStatusColor)).size).toBe(JOB_RUN_STATUSES.length);
  });

  it('gives error its own colour token, so a failure never reads as a quiet success', () => {
    expect(runStatusColor('error')).toBe('var(--status-stuck)');
    expect(runStatusColor('ok')).toBe('var(--status-done)');
  });

  it('does not colour an interruption as a failure', () => {
    // A deploy mid-run is an unknown outcome, not breakage. Red would make every restart look
    // like a broken job.
    expect(runStatusColor('interrupted')).not.toBe(runStatusColor('error'));
    expect(isRunFailure('interrupted')).toBe(false);
    expect(isRunFailure('error')).toBe(true);
  });

  it('relabels the closing timestamp for an interrupted run', () => {
    // Its finishedAt is when the restart was noticed, not when the job stopped.
    expect(endTimeLabel('ok')).toBe('finished');
    expect(endTimeLabel('error')).toBe('finished');
    expect(endTimeLabel('interrupted')).toBe('detected');
  });

  it('titles the reason callout by outcome, not always "Failure"', () => {
    expect(outcomeLabel('error')).toBe('Failure');
    expect(outcomeLabel('interrupted')).toBe('Interrupted');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(185_000)).toBe('3m 5s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_840_000)).toBe('1h 4m');
  });

  it('rounds a sub-second run up to 1s rather than showing 0s', () => {
    // "0s" reads as "it did not run"; the run demonstrably did.
    expect(formatDuration(4)).toBe('1s');
    expect(formatDuration(0)).toBe('1s');
  });

  it('returns a dash for nonsense rather than NaN', () => {
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });
});

describe('runDuration', () => {
  it('measures finish minus start', () => {
    expect(runDuration(run({ startedAt: 0, finishedAt: 90_000 }))).toBe('1m 30s');
  });

  it('is null while the run is in flight', () => {
    expect(runDuration(run({ status: 'running', finishedAt: null }))).toBeNull();
  });

  it('refuses to derive a duration for an interrupted run', () => {
    // Interrupted Monday, swept Thursday: finishedAt - startedAt is three days, and the run
    // certainly did not take three days. "3d" would be a confident lie sitting right next to a
    // message saying we don't know what happened.
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const swept = run({ status: 'interrupted', startedAt: 0, finishedAt: threeDays });
    expect(runDuration(swept)).toBeNull();
    // The same span on a real run is reported normally — it is the status that makes it unknown.
    expect(runDuration(run({ status: 'ok', startedAt: 0, finishedAt: threeDays }))).toBe('72h');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000;
  const minute = 60_000;

  it('collapses the last minute to "just now"', () => {
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 44_000, now)).toBe('just now');
  });

  it('counts minutes, hours and days, singular and plural', () => {
    expect(relativeTime(now - minute, now)).toBe('1 minute ago');
    expect(relativeTime(now - 4 * minute, now)).toBe('4 minutes ago');
    expect(relativeTime(now - 60 * minute, now)).toBe('1 hour ago');
    expect(relativeTime(now - 5 * 60 * minute, now)).toBe('5 hours ago');
    expect(relativeTime(now - 24 * 60 * minute, now)).toBe('1 day ago');
    expect(relativeTime(now - 3 * 24 * 60 * minute, now)).toBe('3 days ago');
  });

  it('falls back to a date past a month, where "47 days ago" stops being useful', () => {
    expect(relativeTime(now - 60 * 24 * 60 * minute, now)).toMatch(/\d/);
    expect(relativeTime(now - 60 * 24 * 60 * minute, now)).not.toMatch(/ago/);
  });

  it('does not render a future timestamp as negative', () => {
    expect(relativeTime(now + 10 * minute, now)).toBe('just now');
  });
});

describe('runDetailPath', () => {
  it('is null for a job that records no runs — there is nothing to link to', () => {
    expect(runDetailPath(job(), 7)).toBeNull();
  });

  it('uses the generic route by default', () => {
    expect(runDetailPath(job({ runs: { jobName: 'bst-scan' } }), 7)).toBe('/devops/jobs/bst-scan/7');
  });

  it('lets a job register its own richer report page', () => {
    const audit = job({
      runs: { jobName: 'task-monitor:audit', detailHref: (id) => `/devops/reports/ticket-audit/${id}` },
    });
    expect(runDetailPath(audit, 12)).toBe('/devops/reports/ticket-audit/12');
  });

  it('encodes a job name containing a colon, which the audit’s does', () => {
    expect(genericRunDetailPath('task-monitor:audit', 3)).toBe('/devops/jobs/task-monitor%3Aaudit/3');
  });
});

describe('defaultHeadline', () => {
  it('renders the job’s own numbers without knowing what they mean', () => {
    const h = defaultHeadline(run({ summary: { scanned: 142, matched: 34 } }));
    expect(h).toBe('Scanned: 142 · Matched: 34');
  });

  it('leads with the failure reason on an error run', () => {
    expect(defaultHeadline(run({ status: 'error', error: 'reddit 403' }))).toBe('reddit 403');
  });

  it('falls back to a generic failure label when the error is missing', () => {
    expect(defaultHeadline(run({ status: 'error', error: null }))).toBe('Failed');
  });

  it('says so while in flight', () => {
    expect(defaultHeadline(run({ status: 'running', finishedAt: null }))).toBe('In progress…');
  });

  it('explains an interrupted run rather than showing stale numbers', () => {
    const swept = run({
      status: 'interrupted',
      error: 'the server restarted while this run was in flight',
      summary: { scanned: 12 },
    });
    expect(defaultHeadline(swept)).toBe('the server restarted while this run was in flight');
    expect(defaultHeadline(run({ status: 'interrupted', error: null }))).toBe(
      'Interrupted before it finished',
    );
  });

  it('handles a run with no summary, and one whose summary is all nested', () => {
    expect(defaultHeadline(run({ summary: null }))).toBe('No details recorded');
    expect(defaultHeadline(run({ summary: { threads: [{ id: 'a' }] } }))).toBe(
      'No details recorded',
    );
  });

  it('keeps scalars and drops nested values from the one-line row', () => {
    const h = defaultHeadline(run({ summary: { matched: 3, threads: [{ id: 'a' }] } }));
    expect(h).toBe('Matched: 3');
  });
});

describe('humanizeKey', () => {
  it('turns camelCase and snake_case into a readable label', () => {
    expect(humanizeKey('threadsRead')).toBe('Threads read');
    expect(humanizeKey('threads_read')).toBe('Threads read');
    expect(humanizeKey('scanned')).toBe('Scanned');
  });
});
