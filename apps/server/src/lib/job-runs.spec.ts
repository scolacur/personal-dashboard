import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  bootstrapJobRunsSchema,
  startRun,
  finishRun,
  listRuns,
  getRun,
  recordRun,
} from './job-runs';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapJobRunsSchema(db);
});

describe('bootstrapJobRunsSchema', () => {
  it('is idempotent', () => {
    startRun(db, 'a-job');
    expect(() => bootstrapJobRunsSchema(db)).not.toThrow();
    expect(listRuns(db, 'a-job')).toHaveLength(1);
  });

  it('closes runs left `running` by a crashed process, rather than spinning forever', () => {
    const orphan = startRun(db, 'a-job');
    expect(orphan.status).toBe('running');

    bootstrapJobRunsSchema(db); // stands in for the next boot

    const after = getRun(db, orphan.id);
    expect(after?.status).toBe('interrupted');
    expect(after?.finishedAt).not.toBeNull();
    expect(after?.error).toMatch(/restarted/);
  });

  it('marks an interrupted run `interrupted`, never `error`', () => {
    // The cause belongs in the schema, not in prose. Counting deploys as job failures — or
    // telling them apart by string-matching the message — is exactly what this prevents.
    startRun(db, 'a-job');
    bootstrapJobRunsSchema(db);
    expect(listRuns(db, 'a-job').filter((r) => r.status === 'error')).toHaveLength(0);
  });

  it('leaves already-closed runs alone across a boot', () => {
    const ok = startRun(db, 'a-job');
    finishRun(db, ok.id, { status: 'ok', summary: { n: 1 } });
    const failed = startRun(db, 'a-job');
    finishRun(db, failed.id, { status: 'error', error: 'real failure' });

    bootstrapJobRunsSchema(db);

    expect(getRun(db, ok.id)).toMatchObject({ status: 'ok', summary: { n: 1 } });
    expect(getRun(db, failed.id)).toMatchObject({ status: 'error', error: 'real failure' });
  });
});

describe('startRun / finishRun', () => {
  it('opens a run with no end and no outcome yet', () => {
    const run = startRun(db, 'bst-scan', 1000);
    expect(run).toMatchObject({
      jobName: 'bst-scan',
      startedAt: 1000,
      finishedAt: null,
      status: 'running',
      summary: null,
      error: null,
    });
  });

  it('round-trips the job-defined summary through JSON', () => {
    const run = startRun(db, 'bst-scan');
    const closed = finishRun(db, run.id, {
      status: 'ok',
      summary: { scanned: 142, matched: 34, threads: ['a', 'b'] },
    });
    expect(closed?.summary).toEqual({ scanned: 142, matched: 34, threads: ['a', 'b'] });
    expect(closed?.status).toBe('ok');
  });

  it('records the failure reason on an error run', () => {
    const run = startRun(db, 'bst-scan');
    const closed = finishRun(db, run.id, { status: 'error', error: 'reddit said no' });
    expect(closed).toMatchObject({ status: 'error', error: 'reddit said no', summary: null });
  });

  it('returns null for a run id that does not exist', () => {
    expect(finishRun(db, 999, { status: 'ok' })).toBeNull();
    expect(getRun(db, 999)).toBeNull();
  });
});

describe('listRuns', () => {
  it('returns only the named job’s runs, newest first', () => {
    startRun(db, 'job-a', 100);
    startRun(db, 'job-b', 150);
    startRun(db, 'job-a', 200);

    const runs = listRuns(db, 'job-a');
    expect(runs.map((r) => r.startedAt)).toEqual([200, 100]);
  });

  it('breaks a same-millisecond tie by id, so ordering is total', () => {
    const first = startRun(db, 'job-a', 100);
    const second = startRun(db, 'job-a', 100);
    expect(listRuns(db, 'job-a').map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('caps at `limit` from the newest end', () => {
    for (let i = 0; i < 5; i++) startRun(db, 'job-a', 100 + i);
    expect(listRuns(db, 'job-a', 2).map((r) => r.startedAt)).toEqual([104, 103]);
  });

  it('is empty, not an error, for a job that has never run', () => {
    expect(listRuns(db, 'never-ran')).toEqual([]);
  });
});

describe('recordRun', () => {
  it('opens and closes a run around the work, and returns the work’s value', async () => {
    const result = await recordRun(db, 'job-a', (ctx) => {
      // The run is visible as in-flight *while* the work runs — that is what the UI polls.
      expect(getRun(db, ctx.runId)?.status).toBe('running');
      ctx.setSummary({ scanned: 3 });
      return 'done';
    });

    expect(result).toBe('done');
    const [run] = listRuns(db, 'job-a');
    expect(run).toMatchObject({ status: 'ok', summary: { scanned: 3 }, error: null });
    expect(run.finishedAt).not.toBeNull();
  });

  it('awaits async work', async () => {
    await recordRun(db, 'job-a', async (ctx) => {
      await Promise.resolve();
      ctx.setSummary({ ok: true });
    });
    expect(listRuns(db, 'job-a')[0]).toMatchObject({ status: 'ok', summary: { ok: true } });
  });

  it('closes ok with a null summary when the job supplies none', async () => {
    await recordRun(db, 'job-a', () => undefined);
    expect(listRuns(db, 'job-a')[0]).toMatchObject({ status: 'ok', summary: null });
  });

  it('takes the last setSummary call', async () => {
    await recordRun(db, 'job-a', (ctx) => {
      ctx.setSummary({ n: 1 });
      ctx.setSummary({ n: 2 });
    });
    expect(listRuns(db, 'job-a')[0].summary).toEqual({ n: 2 });
  });

  it('records a throw as an error run and rethrows it', async () => {
    // Rethrowing matters: CronRegistry logs the failure. Swallowing it here would make a broken
    // job indistinguishable in the logs from one that never fired.
    await expect(
      recordRun(db, 'job-a', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(listRuns(db, 'job-a')[0]).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('keeps the partial summary of a job that threw after doing some work', async () => {
    await expect(
      recordRun(db, 'job-a', (ctx) => {
        ctx.setSummary({ threadsRead: 1 });
        throw new Error('second thread 403d');
      }),
    ).rejects.toThrow();

    expect(listRuns(db, 'job-a')[0]).toMatchObject({
      status: 'error',
      summary: { threadsRead: 1 },
      error: 'second thread 403d',
    });
  });

  it('honours an outcome the work reported by return value', async () => {
    // Not every job signals trouble by throwing — the r/modular scan reports `partial` in its
    // return value on purpose, so the wrapper must not close every non-throwing run `ok`.
    await recordRun(db, 'job-a', (ctx) => {
      ctx.setSummary({ read: 1 });
      ctx.setOutcome('partial', '1 of 2 threads could not be read');
    });

    expect(listRuns(db, 'job-a')[0]).toMatchObject({
      status: 'partial',
      summary: { read: 1 },
      error: '1 of 2 threads could not be read',
    });
  });

  it('lets a throw override an outcome already set', async () => {
    // The throw is the later and more severe fact.
    await expect(
      recordRun(db, 'job-a', (ctx) => {
        ctx.setOutcome('partial', 'one thread failed');
        throw new Error('then the DB went away');
      }),
    ).rejects.toThrow();

    expect(listRuns(db, 'job-a')[0]).toMatchObject({
      status: 'error',
      error: 'then the DB went away',
    });
  });

  it('stringifies a non-Error throw rather than losing it', async () => {
    await expect(recordRun(db, 'job-a', () => Promise.reject('plain string'))).rejects.toBeTruthy();
    expect(listRuns(db, 'job-a')[0].error).toBe('plain string');
  });
});
