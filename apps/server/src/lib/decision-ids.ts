import type Database from 'better-sqlite3';
import { HIGHEST_DECISION_ON_DISK } from './decision-seed.generated';

/**
 * Decision-id allocation (PD-557, part of PD-556 — allocate decision ids at authoring time).
 *
 * Core infrastructure rather than a widget's concern, so it lives in `apps/server/src/lib/`
 * beside the job-run store (PD-442) and the maintenance holds (PD-498).
 *
 * ## Why this exists at all
 *
 * Under D-078 an author never picks a number: they write `DECISIONS/incoming/D-TMP-PD513a.md` and
 * a nightly cycle converts the provisional id into a real `D-NNN`, rewriting every citation across
 * the repo. That conversion is the source of essentially every problem the decision system has —
 * it is a repo-wide rename, so it reds path-guard on every run (PD-547), it cannot distinguish a
 * citation from a fixture that looks like one (PD-548, which it proved by corrupting its own tests
 * on 2026-08-23), and the whole apparatus exists only because an id could not be known when it was
 * written.
 *
 * If the id is right the moment it is written, none of that exists. This is the thing that makes
 * that possible.
 *
 * ## Why the number lives in the DB and the decision does not
 *
 * Only *allocation* needs the database. Decision **content** deliberately stays in git: a decision
 * arrives in the PR diff next to the code that motivated it, `git grep D-078` works offline from
 * any checkout at any commit, and git is distributed, versioned and backed up. Moving content into
 * a table would buy none of that back and would make PD-550's backup job load-bearing for the
 * project's reasoning record.
 *
 * ## Why allocation is a write, performed here
 *
 * D-039 makes a Robot DB-blind, and PD-558 softens that to "may read, never writes". Allocation
 * cannot ride on the read half: two authors who both *read* "next = 86" both get 86, which is the
 * precise collision this removes. The increment has to be atomic, so the **server** performs it and
 * the author asks over HTTP. The Robot still never touches the database — it asks something that
 * can.
 *
 * ## Gaps are fine
 *
 * An id allocated for a PR that is later abandoned is simply never used, leaving a hole in the
 * sequence. That is harmless: `D-086` is an identifier, not a count of anything. There is
 * deliberately **no reclaim path** — reuse is how you end up with two decisions wearing one number,
 * which is exactly the failure D-056 and D-065 already produced when numbers were picked by hand.
 */

/**
 * The number a fresh counter seeds at: the highest `D-NNN` that has a file in `DECISIONS/`.
 *
 * Seeding below a live id would silently re-issue it, so the value is not trusted on its own:
 * `decision-ids.spec.ts` derives the real highest number from `DECISIONS/` and fails if this has
 * fallen behind. The fix for that failure is `npm run decisions:index` — the command every new
 * decision already requires — which regenerates `decision-seed.generated.ts` (PD-702).
 *
 * It is baked into source rather than scanned at runtime because the server image does not contain
 * `DECISIONS/` (see `docker/Dockerfile` — the runtime stage copies only `dist`, `build` and
 * `node_modules`), so there is nothing on disk in production to scan.
 *
 * **It only matters for a fresh DB.** The counter row is seeded once, ever (`INSERT OR IGNORE`
 * below), so production's live counter is unaffected by this value changing.
 *
 * **History.** It began as a hand-maintained literal: 79 when the counter shipped, raised by the
 * PD-560 cutover (which allocated `D-080`–`D-088` from this very counter), then bumped by hand for
 * every decision after — PD-610 (D-089), PD-693 (D-090), PD-632 (D-091). Each bump was the same
 * mechanical edit, and each new decision file broke `npm run verify` until it was made. PD-702
 * replaced the literal with the generated floor. The old rule "never lower it" is now enforced by
 * the generator itself (`renderSeedModule` takes the max), not by a comment.
 */
export const HIGHEST_DECISION_AT_SEED = HIGHEST_DECISION_ON_DISK;

/** `80` → `D-080`. Zero-padded to three digits, matching every existing decision filename. */
export function formatDecisionId(num: number): string {
  return `D-${String(num).padStart(3, '0')}`;
}

export function bootstrapDecisionIdsSchema(db: Database.Database): void {
  db.exec(`
    /* One row, ever. The CHECK is what makes that structural rather than conventional: a second
       row cannot be inserted, so no code path can accidentally create a second counter and start
       handing out numbers from it. */
    CREATE TABLE IF NOT EXISTS decision_id_counter (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      last_num INTEGER NOT NULL
    );
  `);

  /* Seeded once, ever. `INSERT OR IGNORE` rather than a "is it empty?" check because bootstrap runs
     on every process start: re-seeding on a later deploy would rewind the counter to the value of
     whatever `HIGHEST_DECISION_AT_SEED` said that day and re-issue every id allocated since. */
  db.prepare('INSERT OR IGNORE INTO decision_id_counter (id, last_num) VALUES (1, ?)').run(
    HIGHEST_DECISION_AT_SEED,
  );
}

/**
 * Hand out the next decision id, atomically.
 *
 * A single `UPDATE … RETURNING` — one statement, so SQLite wraps it in its own transaction and two
 * callers can never observe the same `last_num`. Deliberately not read-then-write, which is the
 * same shape as the collision this exists to prevent and would reintroduce it under concurrency
 * even though allocation is single-process today.
 *
 * Never returns a number it has returned before, whether or not the previous one was used.
 */
export function allocateDecisionId(db: Database.Database): string {
  const row = db
    .prepare('UPDATE decision_id_counter SET last_num = last_num + 1 WHERE id = 1 RETURNING last_num')
    .get() as { last_num: number } | undefined;

  if (!row) {
    // The counter row is created by bootstrap and cannot be deleted by any code here, so this means
    // the caller skipped bootstrap. Fail loudly: silently seeding one now would start from a number
    // this module has no way to know is free.
    throw new Error('decision id counter is missing — bootstrapDecisionIdsSchema was never run');
  }

  return formatDecisionId(row.last_num);
}

/**
 * The id the next {@link allocateDecisionId} will return, without consuming it.
 *
 * Read-only, for status surfaces and tests. Not exposed as an endpoint an author can use in place
 * of allocating: acting on this value is precisely the read-then-write race.
 */
export function peekNextDecisionId(db: Database.Database): string {
  const row = db.prepare('SELECT last_num FROM decision_id_counter WHERE id = 1').get() as
    | { last_num: number }
    | undefined;
  if (!row) throw new Error('decision id counter is missing — bootstrapDecisionIdsSchema was never run');
  return formatDecisionId(row.last_num + 1);
}
