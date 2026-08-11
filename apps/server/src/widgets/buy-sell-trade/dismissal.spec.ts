import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BstCommentInput } from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import {
  createListing,
  ingestComments,
  listMatches,
  purgeIgnoredAuthorMatches,
  setMatchDismissed,
} from './store';

// Two questions about the matches table that are only answerable at the store layer, because
// both are about what survives a SECOND scan of the same thread.

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
});

function comment(over: Partial<BstCommentInput> = {}): BstCommentInput {
  return {
    id: 'c1',
    author: 'someone_else',
    body: 'WTB Make Noise Maths, cash ready',
    permalink: 'https://reddit.com/r/modular/comments/x/_/c1',
    ...over,
  };
}

/** One scan of one thread. Re-running with the same comments is a re-scan of the same thread. */
function scan(comments: BstCommentInput[] = [comment()]) {
  return ingestComments(db, { threadId: 't1', comments });
}

describe('a dismissed match is never re-surfaced by a later scan', () => {
  it('stays dismissed when the same comment is scanned again', () => {
    scan();
    const [match] = listMatches(db);
    setMatchDismissed(db, match.id, true);
    expect(listMatches(db)).toHaveLength(0);

    // The same thread, scanned again a week later — the two-thread overlap in PD-471 means this
    // happens on purpose, every week, for as long as the thread stays in the feed.
    const result = scan();

    expect(listMatches(db)).toHaveLength(0);
    expect(listMatches(db, true)).toHaveLength(1);
    expect(listMatches(db, true)[0].dismissedAt).not.toBeNull();
    // The re-scan recognised it as already known rather than inserting a second row.
    expect(result).toMatchObject({ matched: 1, created: 0, duplicates: 1 });
  });

  it('does not reset dismissed_at, so it cannot resurface later either', () => {
    scan();
    const [match] = listMatches(db);
    setMatchDismissed(db, match.id, true);
    const dismissedAt = listMatches(db, true)[0].dismissedAt;

    scan();
    scan();

    expect(listMatches(db, true)[0].dismissedAt).toBe(dismissedAt);
  });

  it('is per comment, so a NEW comment on the same thread still surfaces', () => {
    // The guarantee must not be "this thread is done" — a fresh offer next week is the point.
    scan();
    setMatchDismissed(db, listMatches(db)[0].id, true);

    scan([comment(), comment({ id: 'c2', permalink: 'https://reddit.com/r/modular/x/_/c2' })]);

    const open = listMatches(db);
    expect(open).toHaveLength(1);
    expect(open[0].commentId).toBe('c2');
  });
});

describe('ignored authors', () => {
  it('never produces a match from Steve’s own account', () => {
    // His own BST post lists the same gear as his listings, so every item he is selling matches
    // his own comment. The matcher is right about the text; the author is what makes it noise.
    const result = scan([comment({ author: 'holographicbboy' })]);
    expect(result).toMatchObject({ scanned: 1, matched: 0, created: 0 });
    expect(listMatches(db, true)).toHaveLength(0);
  });

  it('ignores casing and a u/ prefix', () => {
    scan([
      comment({ id: 'a', author: 'HolographicBboy' }),
      comment({ id: 'b', author: 'u/holographicbboy' }),
    ]);
    expect(listMatches(db, true)).toHaveLength(0);
  });

  it('still matches everybody else in the same batch', () => {
    const result = scan([
      comment({ id: 'a', author: 'holographicbboy' }),
      comment({ id: 'b', author: 'a_real_buyer' }),
    ]);
    expect(result).toMatchObject({ matched: 1, created: 1 });
    expect(listMatches(db)[0].author).toBe('a_real_buyer');
  });

  it('purges matches recorded before the author was ignored', () => {
    // Existing noise has to go, not just stop accumulating — the whole reason this was reported.
    db.prepare(
      `INSERT INTO buy_sell_trade_matches
         (listing_id, thread_id, comment_id, permalink, author, author_url, intent, excerpt, matched_at)
       VALUES (1, 't0', 'old1', 'p', 'holographicbboy', 'u', 'WTS', 'x', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO buy_sell_trade_matches
         (listing_id, thread_id, comment_id, permalink, author, author_url, intent, excerpt, matched_at)
       VALUES (1, 't0', 'old2', 'p', 'someone_else', 'u', 'WTB', 'x', 1)`,
    ).run();

    expect(purgeIgnoredAuthorMatches(db)).toBe(1);

    const left = listMatches(db, true);
    expect(left).toHaveLength(1);
    expect(left[0].author).toBe('someone_else');
  });

  it('purges a stored name whatever its casing or prefix', () => {
    // LOWER has to run before the u/ strip — on "U/holographicbboy" the other order leaves the
    // prefix in place and the row survives.
    for (const [i, author] of ['U/HolographicBboy', 'u/holographicbboy', 'HOLOGRAPHICBBOY'].entries()) {
      db.prepare(
        `INSERT INTO buy_sell_trade_matches
           (listing_id, thread_id, comment_id, permalink, author, author_url, intent, excerpt, matched_at)
         VALUES (1, 't0', ?, 'p', ?, 'u', 'WTS', 'x', 1)`,
      ).run(`old${i}`, author);
    }
    expect(purgeIgnoredAuthorMatches(db)).toBe(3);
    expect(listMatches(db, true)).toHaveLength(0);
  });

  it('is idempotent — it runs on every boot', () => {
    expect(purgeIgnoredAuthorMatches(db)).toBe(0);
    expect(purgeIgnoredAuthorMatches(db)).toBe(0);
  });
});
