import type Database from 'better-sqlite3';
import { writeState } from './state';

/**
 * Circuit breaker (t974, D-107) — pauses the WHOLE Robot loop after N consecutive
 * **deterministic-tier** run failures across **distinct** tickets.
 *
 * ## Why this exists
 *
 * Before this, a failing run only halted the loop on a *system-wide* fault (auth/credit 401/403,
 * `faults.ts`). A **deterministic** fault parks just that one ticket (`stuck`) and dispatch carries
 * on — which is correct for a one-off, but wrong when run after run is failing the same structural
 * way (a broken setup, a path-guard the whole batch trips, a bad base). With the promoter feeding
 * the Queue automatically (D-103), nothing stopped the line in that case; the breaker is the stop.
 *
 * ## Design (D-107)
 *
 * The streak lives in the worker-owned `robot_state` k/v table in its OWN slot (same discipline as
 * the holds in `state.ts`: one condition, one slot — never a shared key), as the JSON list of the
 * distinct tickets that have failed deterministically in a row. The list is both the count (its
 * length) and the evidence the trip notification needs (which tickets, which fault signatures).
 *
 *   - **distinct tickets**: a ticket already in the streak refreshes its signature but does NOT grow
 *     the count. One ticket flapping is already handled per-ticket by the retry cap / promotion
 *     (`faults.ts`); the breaker is for a *systemic* failure, so it counts distinct tickets.
 *   - **consecutive**: reset to empty on any successful hand-off (`robot.ts`) and on a human resume
 *     (the server's `setDispatchPaused(db, false)` nulls the same key — resume is the only human
 *     reset, per the ticket). A transient retry neither counts nor resets.
 *   - **the pause itself** reuses the single `dispatch_paused` flag (`pauseDispatch`, D-072), so the
 *     existing resume control clears it and the existing Dev Ops readouts render it — only the
 *     reason string is distinguished, by the `circuit-breaker` token.
 */

/** This breaker's own `robot_state` slot. A literal, mirroring the convention the other worker
 *  flags use (`dispatch_paused`, `session_limit_until`, …). The server clears it on resume with the
 *  same literal — keep the two in step. */
export const BREAKER_KEY = 'breaker_consecutive';

export interface BreakerFailure {
  ticketId: number;
  /** The ticket title, carried so the trip notification can name tickets without a DB round-trip. */
  title: string;
  /** The fault signature (`faults.ts`), so the notification names WHAT failed, not just where. */
  signature: string;
}

/** The current deterministic-failure streak (the distinct tickets, oldest first), or `[]` when none
 *  is recorded / the row is corrupt. Pure read. */
export function breakerFailures(db: Database.Database): BreakerFailure[] {
  const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(BREAKER_KEY) as
    | { value: string | null }
    | undefined;
  if (!row || row.value === null) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (f): f is BreakerFailure =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as BreakerFailure).ticketId === 'number' &&
          typeof (f as BreakerFailure).signature === 'string',
      )
      .map((f) => ({ ticketId: f.ticketId, title: typeof f.title === 'string' ? f.title : `t${f.ticketId}`, signature: f.signature }));
  } catch {
    return []; // a corrupt row must not wedge the breaker into a false trip
  }
}

/**
 * Record one deterministic-tier failure and return the updated streak. Deduped by `ticketId`: a
 * ticket already in the streak is moved to the end with its latest signature, but the count does not
 * grow — the breaker trips on N *distinct* tickets, never on one ticket flapping.
 */
export function recordDeterministicFailure(
  db: Database.Database,
  failure: BreakerFailure,
  now: number = Date.now(),
): BreakerFailure[] {
  const next = [...breakerFailures(db).filter((f) => f.ticketId !== failure.ticketId), failure];
  writeState(db, BREAKER_KEY, JSON.stringify(next), now);
  return next;
}

/** Clear the streak. Called on a successful hand-off (the loop) and on a human resume (the server). */
export function resetBreaker(db: Database.Database, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = NULL, updated_at = excluded.updated_at`,
  ).run(BREAKER_KEY, now);
}

/** The distinguishable pause reason. Carries the `circuit-breaker` token (so Dev Ops can tell it
 *  apart from a human pause or an auth fault) plus the failing ticket ids. */
export function breakerPauseReason(failures: readonly BreakerFailure[]): string {
  const ids = failures.map((f) => `t${f.ticketId}`).join(', ');
  return `circuit-breaker: ${failures.length} consecutive deterministic failures across distinct tickets (${ids})`;
}

/** The Notification Center body: one line per failing ticket, naming it and its fault signature. */
export function breakerNotificationBody(failures: readonly BreakerFailure[]): string {
  const lines = failures.map((f) => `• ${f.title} (t${f.ticketId}): ${f.signature}`);
  return [
    `Dispatch paused after ${failures.length} consecutive deterministic failures across distinct tickets.`,
    `Fix the underlying cause, then resume dispatch from Dev Ops.`,
    '',
    ...lines,
  ].join('\n');
}
