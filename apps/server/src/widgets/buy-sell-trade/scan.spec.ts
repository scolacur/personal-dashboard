import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import { runScan } from './scan';
import { createListing, latestScan, listMatches, listScans } from './store';
import { RedditFeedError, type RedditRssReader } from './reddit-rss';

// The contract under test is not "does it fetch" — that is reddit-rss.spec.ts. It is:
// **a scan never reports a clean run it did not have.**

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  createListing(db, { type: 'WTS', item: 'Morgasmatron', manufacturer: 'Intellijel' });
  createListing(db, { type: 'WTB', item: 'Eloquencer', manufacturer: 'Winter Modular' });
});

const THREADS = [
  { id: 'aaa', title: 'Monthly Modular Buy Sell Trade Thread', url: 'https://r/x/comments/aaa/' },
  { id: 'bbb', title: 'Monthly Modular Buy Sell Trade Thread', url: 'https://r/x/comments/bbb/' },
];

const comment = (id: string, body: string) => ({
  id,
  author: 'someone',
  body,
  permalink: `https://reddit.com/c/${id}`,
});

/** A reader stubbed per thread url; an Error value makes that thread fail. */
function stub(
  threads: typeof THREADS | Error,
  byUrl: Record<string, ReturnType<typeof comment>[] | Error> = {},
): RedditRssReader {
  return {
    findBstThreads: async () => {
      if (threads instanceof Error) throw threads;
      return threads;
    },
    fetchComments: async (url: string) => {
      const r = byUrl[url];
      if (r instanceof Error) throw r;
      return r ?? [];
    },
  } as unknown as RedditRssReader;
}

describe('runScan — the happy path', () => {
  it('reads both threads and records an ok scan', async () => {
    const scan = await runScan(db, {
      reader: stub(THREADS, {
        [THREADS[0].url]: [comment('c1', 'WTS Intellijel Morgasmatron $390')],
        [THREADS[1].url]: [comment('c2', 'WTS Winter Modular Eloquencer $350')],
      }),
    });
    expect(scan.status).toBe('ok');
    expect(scan.error).toBeNull();
    expect(scan.threads).toHaveLength(2);
    expect(scan.threads.every((t) => t.error === null)).toBe(true);
    expect(listMatches(db)).toHaveLength(2);
  });

  it('scans two threads, so deals on last month’s thread are not missed', async () => {
    const scan = await runScan(db, {
      reader: stub(THREADS, {
        [THREADS[1].url]: [comment('old', 'WTS Intellijel Morgasmatron, still available')],
      }),
    });
    expect(scan.threads.map((t) => t.url)).toEqual([THREADS[0].url, THREADS[1].url]);
    expect(listMatches(db)).toHaveLength(1);
  });

  // Same property that makes re-scanning safe: the overlap between the two threads costs nothing.
  it('is idempotent — re-scanning writes no duplicate matches', async () => {
    const reader = stub(THREADS, {
      [THREADS[0].url]: [comment('c1', 'WTS Intellijel Morgasmatron $390')],
    });
    await runScan(db, { reader });
    const second = await runScan(db, { reader });
    expect(second.status).toBe('ok');
    expect(second.threads[0].created).toBe(0);
    expect(listMatches(db)).toHaveLength(1);
  });
});

describe('runScan — never lies about what it saw', () => {
  // The whole point. A quiet week and a blocked request must not look alike.
  it('records FAILED, not a quiet scan, when discovery is rate limited', async () => {
    const scan = await runScan(db, {
      reader: stub(new RedditFeedError('search.rss returned HTTP 429 — rate limited', 'http', 'u', 429)),
    });
    expect(scan.status).toBe('failed');
    expect(scan.error).toMatch(/429/);
    expect(scan.threads).toHaveLength(0);
    expect(listMatches(db)).toHaveLength(0);
  });

  it('records FAILED when the thread naming convention changed', async () => {
    const scan = await runScan(db, {
      reader: stub(new RedditFeedError('no Buy/Sell/Trade thread among 10 results', 'not-found', 'u')),
    });
    expect(scan.status).toBe('failed');
    expect(scan.error).toMatch(/naming|Buy\/Sell\/Trade/i);
  });

  // The case that most needs its own status: one thread read, one refused.
  it('records PARTIAL when one thread fails and the other succeeds', async () => {
    const scan = await runScan(db, {
      reader: stub(THREADS, {
        [THREADS[0].url]: [comment('c1', 'WTS Intellijel Morgasmatron $390')],
        [THREADS[1].url]: new RedditFeedError('HTTP 429 — rate limited', 'http', 'u', 429),
      }),
    });
    expect(scan.status).toBe('partial');
    expect(scan.threads[0].error).toBeNull();
    expect(scan.threads[1].error).toMatch(/429/);
    // The matches it DID find are kept — half the week's offers beats none.
    expect(listMatches(db)).toHaveLength(1);
  });

  it('records FAILED when every thread fails', async () => {
    const scan = await runScan(db, {
      reader: stub(THREADS, {
        [THREADS[0].url]: new RedditFeedError('HTTP 403', 'http', 'u', 403),
        [THREADS[1].url]: new RedditFeedError('HTTP 403', 'http', 'u', 403),
      }),
    });
    expect(scan.status).toBe('failed');
    expect(scan.threads.every((t) => t.error)).toBe(true);
  });

  // A genuinely quiet week is `ok` with zero matches — distinguishable from every case above.
  it('records OK with no matches when the threads simply had no offers for him', async () => {
    const scan = await runScan(db, {
      reader: stub(THREADS, {
        [THREADS[0].url]: [comment('c1', 'anyone know a good beginner case?')],
      }),
    });
    expect(scan.status).toBe('ok');
    expect(scan.threads.every((t) => t.error === null)).toBe(true);
    expect(listMatches(db)).toHaveLength(0);
  });

  it('never throws — the caller always gets a scan record to display', async () => {
    const scan = await runScan(db, { reader: stub(new Error('socket hang up')) });
    expect(scan.status).toBe('failed');
    expect(scan.error).toMatch(/socket hang up/);
  });
});

describe('scan persistence', () => {
  // Loudness that lives only in an HTTP response is no use to a job that runs at 3am.
  it('persists every scan, including the failures', async () => {
    await runScan(db, { reader: stub(THREADS, {}) });
    await runScan(db, { reader: stub(new RedditFeedError('HTTP 429', 'http', 'u', 429)) });
    const all = listScans(db);
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe('failed');
    expect(latestScan(db)?.status).toBe('failed');
  });

  it('round-trips the per-thread breakdown through storage', async () => {
    await runScan(db, {
      reader: stub(THREADS, {
        [THREADS[0].url]: [comment('c1', 'WTS Intellijel Morgasmatron $390')],
        [THREADS[1].url]: new RedditFeedError('HTTP 429', 'http', 'u', 429),
      }),
    });
    const stored = latestScan(db)!;
    expect(stored.status).toBe('partial');
    expect(stored.threads).toHaveLength(2);
    expect(stored.threads[0].matched).toBe(1);
    expect(stored.threads[1].error).toMatch(/429/);
  });

  it('returns null before the scanner has ever run', () => {
    expect(latestScan(db)).toBeNull();
  });
});
