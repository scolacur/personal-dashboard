import type Database from 'better-sqlite3';
import type { BstScan, BstScanStatus, BstScanThreadResult } from '@dashboard/shared';
import { RedditFeedError, RedditRssReader } from './reddit-rss';
import { ingestComments, recordScan } from './store';

/**
 * Run one r/modular BST scan (PD-471).
 *
 * Discover the newest BST threads over public RSS, read each one's comments, and push them
 * through the **existing** ingest path — the same `ingestComments` a hand-pasted thread would
 * use. There is deliberately one matcher entry point.
 *
 * ## The contract: a scan never lies about what it saw
 *
 * - Discovery fails → `failed`. Nothing was read; do not write a scan that looks quiet.
 * - One thread fails, another succeeds → `partial`, with the failing thread's error kept.
 * - Everything read → `ok`.
 *
 * `partial` exists because the honest answer to "did you see this week's offers?" is sometimes
 * "some of them", and collapsing that into `ok` is how a silently half-working scanner survives
 * for months. The UI leads with the status, not the match count.
 */

/** How many BST threads to read per scan.
 *
 *  Two, because **we never have to decide which thread is "current"**. RSS carries no pinned
 *  flag, and for the first days of a month deals still land on the previous thread — the API-era
 *  scanner read exactly one thread and silently missed them. Overlap is free: `ingestComments`
 *  dedupes on `(listing_id, comment_id)`. */
const THREADS_PER_SCAN = 2;

export interface ScanDeps {
  reader?: RedditRssReader;
  /** Injected in tests; real runs use wall-clock. */
  now?: () => number;
}

function describe(e: unknown): string {
  if (e instanceof RedditFeedError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export async function runScan(db: Database.Database, deps: ScanDeps = {}): Promise<BstScan> {
  const reader = deps.reader ?? new RedditRssReader();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  let threads: { id: string; title: string; url: string }[];
  try {
    threads = await reader.findBstThreads(THREADS_PER_SCAN);
  } catch (e) {
    // Nothing was read. Recording this as a scan with zero matches would be indistinguishable
    // from a genuinely quiet week, which is the failure this whole design exists to prevent.
    return recordScan(db, {
      startedAt,
      finishedAt: now(),
      status: 'failed',
      error: `could not find the BST thread: ${describe(e)}`,
      threads: [],
    });
  }

  const results: BstScanThreadResult[] = [];
  for (const thread of threads) {
    try {
      const comments = await reader.fetchComments(thread.url);
      const out = ingestComments(db, { threadId: thread.id, comments });
      results.push({
        title: thread.title,
        url: thread.url,
        scanned: out.scanned,
        matched: out.matched,
        created: out.created,
        error: null,
      });
    } catch (e) {
      // Keep going — the other thread may be readable, and half the week's offers beats none.
      // The status downgrade is what stops this being reported as a clean run.
      results.push({
        title: thread.title,
        url: thread.url,
        scanned: 0,
        matched: 0,
        created: 0,
        error: describe(e),
      });
    }
  }

  const failed = results.filter((r) => r.error).length;
  const status: BstScanStatus =
    failed === 0 ? 'ok' : failed === results.length ? 'failed' : 'partial';

  return recordScan(db, {
    startedAt,
    finishedAt: now(),
    status,
    error: status === 'failed' ? 'every thread failed to read' : null,
    threads: results,
  });
}
