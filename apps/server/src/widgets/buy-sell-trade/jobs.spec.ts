import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { BstScan, BstScanThreadResult } from '@dashboard/shared';
import { BST_SCAN_JOB, BST_DRAFTS_JOB } from '@dashboard/shared';
import { bootstrapJobRunsSchema, listRuns } from '../../lib/job-runs';
import { bootstrapSchema } from './schema';
import { createListing } from './store';
import {
  BST_DRAFTS_SCHEDULE,
  BST_SCAN_SCHEDULE,
  generateDraftsRecorded,
  runScanRecorded,
  summarizeDrafts,
  summarizeScan,
} from './jobs';

vi.mock('./scan', () => ({ runScan: vi.fn() }));
import { runScan } from './scan';

const mockedRunScan = vi.mocked(runScan);

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapJobRunsSchema(db);
  bootstrapSchema(db);
});

function thread(over: Partial<BstScanThreadResult> = {}): BstScanThreadResult {
  return {
    title: 'Monthly Modular Buy Sell Trade Thread',
    url: 'https://reddit.com/r/modular/x',
    scanned: 100,
    matched: 5,
    created: 3,
    error: null,
    ...over,
  };
}

function scan(over: Partial<BstScan> = {}): BstScan {
  return {
    id: 1,
    startedAt: 1000,
    finishedAt: 2000,
    status: 'ok',
    error: null,
    threads: [thread(), thread({ url: 'https://reddit.com/r/modular/y' })],
    ...over,
  };
}

describe('schedules', () => {
  it('defaults to weekly Monday 09:00 and the 15th at 09:00', () => {
    // PD-439 specified `0 9 15 * *`. The scan's weekday was never specified anywhere — see the
    // comment on BST_SCAN_SCHEDULE; the widget's copy used to claim Monday while nothing ran.
    expect(BST_SCAN_SCHEDULE).toBe('0 9 * * 1');
    expect(BST_DRAFTS_SCHEDULE).toBe('0 9 15 * *');
  });
});

describe('summarizeScan', () => {
  it('totals the per-thread numbers', () => {
    expect(summarizeScan(scan())).toEqual({
      threads: 2,
      scanned: 200,
      matched: 10,
      created: 6,
      threadsFailed: 0,
    });
  });

  it('counts the threads that could not be read', () => {
    const s = summarizeScan(
      scan({ threads: [thread(), thread({ scanned: 0, matched: 0, created: 0, error: '429' })] }),
    );
    expect(s).toMatchObject({ threads: 2, threadsFailed: 1, scanned: 100 });
  });
});

describe('runScanRecorded', () => {
  it('records a clean scan as an `ok` run carrying the totals', async () => {
    mockedRunScan.mockResolvedValue(scan());
    await runScanRecorded(db);

    const [run] = listRuns(db, BST_SCAN_JOB);
    expect(run).toMatchObject({ status: 'ok', error: null });
    expect(run.summary).toMatchObject({ scanned: 200, created: 6, threadsFailed: 0 });
  });

  it('records a partial scan as `partial`, never as ok', async () => {
    // This is the whole reason `partial` exists as a run status. `runScan` does not throw on a
    // half-readable week — it returns `partial` — so a wrapper that only watches for throws
    // would file this as a clean run and quietly undo PD-471's central guarantee.
    mockedRunScan.mockResolvedValue(
      scan({
        status: 'partial',
        threads: [thread(), thread({ scanned: 0, matched: 0, created: 0, error: 'HTTP 429' })],
      }),
    );
    await runScanRecorded(db);

    const [run] = listRuns(db, BST_SCAN_JOB);
    expect(run.status).toBe('partial');
    expect(run.error).toContain('1 of 2 threads');
    expect(run.error).toContain('HTTP 429');
    // The half that worked is still recorded — a partial run is not an empty one.
    expect(run.summary).toMatchObject({ scanned: 100, created: 3 });
  });

  it('records a wholly failed scan as `error` with the reason', async () => {
    mockedRunScan.mockResolvedValue(
      scan({ status: 'failed', error: 'could not find the BST thread: HTTP 403', threads: [] }),
    );
    await runScanRecorded(db);

    const [run] = listRuns(db, BST_SCAN_JOB);
    expect(run).toMatchObject({ status: 'error' });
    expect(run.error).toContain('403');
  });

  it('records an unexpected throw as `error` and rethrows', async () => {
    mockedRunScan.mockRejectedValue(new Error('sqlite is on fire'));
    await expect(runScanRecorded(db)).rejects.toThrow('sqlite is on fire');
    expect(listRuns(db, BST_SCAN_JOB)[0]).toMatchObject({
      status: 'error',
      error: 'sqlite is on fire',
    });
  });

  it('returns the scan unchanged, so the route still answers with the full record', async () => {
    const s = scan({ status: 'partial' });
    mockedRunScan.mockResolvedValue(s);
    await expect(runScanRecorded(db)).resolves.toEqual(s);
  });
});

describe('generateDraftsRecorded', () => {
  it('records an `ok` run naming the formats it produced', async () => {
    createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    const drafts = await generateDraftsRecorded(db);

    const [run] = listRuns(db, BST_DRAFTS_JOB);
    expect(run.status).toBe('ok');
    expect(run.summary).toMatchObject({ drafts: drafts.length });
    expect(String(run.summary?.formats)).toContain('reddit');
  });

  it('still records a run when the list is empty — "it ran and found nothing" is the answer', async () => {
    await generateDraftsRecorded(db);
    expect(listRuns(db, BST_DRAFTS_JOB)).toHaveLength(1);
    expect(listRuns(db, BST_DRAFTS_JOB)[0].status).toBe('ok');
  });

  it('summarizes formats as a readable list', () => {
    expect(
      summarizeDrafts([
        { id: 1, format: 'reddit', content: '', generatedAt: 0 },
        { id: 2, format: 'facebook', content: '', generatedAt: 0 },
      ]),
    ).toEqual({ drafts: 2, formats: 'reddit, facebook' });
  });
});
