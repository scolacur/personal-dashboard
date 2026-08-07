import type Database from 'better-sqlite3';
import {
  BST_DRAFTS_JOB,
  BST_SCAN_JOB,
  type BstDraft,
  type BstDraftsRunSummary,
  type BstScan,
  type BstScanRunSummary,
} from '@dashboard/shared';
import type { CronLogger, CronRegistry } from '../../cron';
import { recordRun } from '../../lib/job-runs';
import { generateDrafts } from './store';
import { runScan } from './scan';

/**
 * The Buy/Sell/Trade widget's two scheduled jobs (PD-439, PD-440).
 *
 * Both halves of the epic were reachable only by a button until now: the inbound scan shipped
 * with `POST /scans` and no cron (PD-471 made it *automatic* in the sense of needing no API key
 * and no pasting — the schedule itself was never registered), and the drafter shipped with
 * "Generate now" (PD-475). Both now run on a schedule and record a run through the shared store,
 * which is what makes "did it run?" answerable at all.
 *
 * Job names are namespaced `buy-sell-trade:*` to match the cron registry's existing convention
 * (`task-monitor:audit`) and because `job_runs` is shared across every widget.
 */

// Job names live in @dashboard/shared — the web registry reads runs under the same strings, and
// a typo would present as "this job has never run" rather than as an error.
export { BST_SCAN_JOB, BST_DRAFTS_JOB };

/** Monday 09:00. The weekday is a genuine choice, not a spec: nothing anywhere specified one, and
 *  the widget's copy previously *claimed* Monday while nothing was scheduled at all (PD-476).
 *  Monday morning is when a week's worth of weekend offers is newest. */
export const BST_SCAN_SCHEDULE = process.env.BST_SCAN_SCHEDULE ?? '0 9 * * 1';

/** The 15th at 09:00 — PD-439's specified default, unchanged. */
export const BST_DRAFTS_SCHEDULE = process.env.BST_DRAFTS_SCHEDULE ?? '0 9 15 * *';

export function summarizeScan(scan: BstScan): BstScanRunSummary {
  return {
    threads: scan.threads.length,
    scanned: scan.threads.reduce((n, t) => n + t.scanned, 0),
    matched: scan.threads.reduce((n, t) => n + t.matched, 0),
    created: scan.threads.reduce((n, t) => n + t.created, 0),
    threadsFailed: scan.threads.filter((t) => t.error).length,
  };
}

export function summarizeDrafts(drafts: BstDraft[]): BstDraftsRunSummary {
  return {
    drafts: drafts.length,
    formats: drafts.map((d) => d.format).join(', '),
  };
}

/**
 * Run one scan and record it.
 *
 * `runScan` reports trouble in its **return value**, not by throwing — it catches per-thread
 * failures on purpose, because half the week's offers beat none. So the run's outcome is set
 * explicitly from the scan's own three-valued status; letting the wrapper default to `ok` would
 * silently undo the guarantee PD-471 exists to provide.
 *
 * The scan's own `buy_sell_trade_scans` row is still written by `runScan` — it holds the
 * per-thread breakdown the widget's loud readout needs. Both records derive from the one
 * `BstScan` object, so they cannot disagree. Collapsing the two stores into one is PD-443's job.
 */
export async function runScanRecorded(db: Database.Database): Promise<BstScan> {
  return recordRun(db, BST_SCAN_JOB, async (ctx) => {
    const scan = await runScan(db);
    ctx.setSummary(summarizeScan(scan));
    if (scan.status === 'failed') ctx.setOutcome('error', scan.error ?? 'the scan read nothing');
    else if (scan.status === 'partial') {
      const failed = scan.threads.filter((t) => t.error);
      ctx.setOutcome(
        'partial',
        `${failed.length} of ${scan.threads.length} threads could not be read: ${failed
          .map((t) => t.error)
          .join('; ')}`,
      );
    }
    return scan;
  });
}

/** Render this month's drafts and record the run. A throw here is a real failure — unlike the
 *  scan, `generateDrafts` has no partial state to report. */
export async function generateDraftsRecorded(db: Database.Database): Promise<BstDraft[]> {
  return recordRun(db, BST_DRAFTS_JOB, (ctx) => {
    const drafts = generateDrafts(db);
    ctx.setSummary(summarizeDrafts(drafts));
    return drafts;
  });
}

export function registerBstJobs(
  cron: CronRegistry,
  log: CronLogger,
  db: Database.Database,
): void {
  cron.register(BST_SCAN_JOB, BST_SCAN_SCHEDULE, async () => {
    const scan = await runScanRecorded(db);
    const s = summarizeScan(scan);
    log.info(
      `bst scan: ${scan.status} — ${s.scanned} comments across ${s.threads} thread(s), ${s.created} new match(es)`,
    );
  });

  cron.register(BST_DRAFTS_JOB, BST_DRAFTS_SCHEDULE, async () => {
    const drafts = await generateDraftsRecorded(db);
    log.info(`bst drafts: generated ${drafts.length} draft(s)`);
  });
}
