import type Database from 'better-sqlite3';

/**
 * Circuit breaker (this ticket) — pause the WHOLE loop when N distinct tickets park with a
 * deterministic fault in a row, with no successful hand-off between them.
 *
 * ## Why a count across DISTINCT tickets, and not repeated failures of one ticket
 *
 * A single ticket failing deterministically is already handled by the fault-tier guardrail
 * (faults.ts): it parks after `promoteAfter` and never re-runs, so it cannot burn the board on its
 * own. What the per-ticket guardrail is blind to is a *systemic* break — `main` is broken, the
 * coding env regressed, a dependency went missing — where every ticket the loop touches fails the
 * same structural way, each one parked individually while dispatch keeps feeding the line. With the
 * promoter now filling the Queue automatically (D-103), nothing stops that until a human notices.
 * This breaker does: it counts the DISTINCT tickets that have parked deterministically and trips a
 * loop-wide pause at the threshold.
 *
 * ## What counts, and what resets it
 *
 * Only a **deterministic-tier park** counts. Transient retries do not (they are flakes worth
 * retrying), and system-wide faults do not (they already pause the loop on their own, with zero
 * per-ticket burn — see faults.ts). The count is reset by a **successful hand-off** (the pipeline is
 * demonstrably working again) or by a **human resume** (the deliberate "I looked, carry on"). A
 * breaker pause always waits for a human — it never expires on its own, unlike the session-limit /
 * maintenance holds.
 *
 * State is one worker-owned `robot_state` row (the same k/v store as the pause and the holds): the
 * ordered list of distinct tickets that have parked deterministically since the last reset. Kept as
 * a list, not a bare counter, so the pause reason and notification can NAME the failing tickets and
 * their fault signatures — which is what a human needs to see the common cause at a glance.
 */

/** The `robot_state` key holding the breaker's failing-ticket list. Exported so the server's resume
 *  path can clear it by the same name (a human resume resets the count; store.ts references this). */
export const BREAKER_STATE_KEY = 'circuit_breaker';

/** Prefix on the pause reason, so Dev Ops / logs can tell a breaker pause from an auth pause or a
 *  manual one. The rest of the reason names the failing tickets. */
export const BREAKER_REASON_PREFIX = 'circuit-breaker';

/** One distinct ticket that parked with a deterministic fault since the last reset. */
export interface BreakerFailure {
  ticketId: number;
  /** Display id (e.g. `PD-974`) when known, else null — the label falls back to `#ticketId`. */
  displayId: string | null;
  /** The deterministic fault signature, so the reason/notification shows the common cause. */
  signature: string;
}

/** Read the distinct deterministic failures recorded since the last reset. Tolerant of an absent
 *  table / null row / corrupt JSON — none of which should break a dispatch cycle. */
export function breakerFailures(db: Database.Database): BreakerFailure[] {
  try {
    const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(BREAKER_STATE_KEY) as
      | { value: string | null }
      | undefined;
    if (!row || row.value === null) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f): f is BreakerFailure => typeof f === 'object' && f !== null && typeof (f as BreakerFailure).ticketId === 'number')
      .map((f) => ({
        ticketId: f.ticketId,
        displayId: typeof f.displayId === 'string' ? f.displayId : null,
        signature: typeof f.signature === 'string' ? f.signature : '',
      }));
  } catch {
    return [];
  }
}

/**
 * Record a deterministic-tier park. Deduped by ticket id — the count is DISTINCT tickets, so a
 * ticket re-queued and failing again does not double-count — keeping the first-seen signature.
 * Returns the updated list so the caller can test it against the threshold.
 */
export function recordBreakerFailure(db: Database.Database, failure: BreakerFailure, now: number = Date.now()): BreakerFailure[] {
  const current = breakerFailures(db);
  if (current.some((f) => f.ticketId === failure.ticketId)) return current;
  const next = [...current, failure];
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(BREAKER_STATE_KEY, JSON.stringify(next), now);
  return next;
}

/** Clear the breaker's count. Called on a successful hand-off and on a human resume. */
export function resetBreaker(db: Database.Database, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = NULL, updated_at = excluded.updated_at`,
  ).run(BREAKER_STATE_KEY, now);
}

/** True when the recorded distinct failures have reached the configured threshold. Pure.
 *  `threshold <= 0` disables the breaker. */
export function breakerTripped(failures: BreakerFailure[], threshold: number): boolean {
  return threshold > 0 && failures.length >= threshold;
}

/** The label for one failing ticket in the reason / notification: its id and the fault signature. */
function failureLabel(f: BreakerFailure): string {
  return `${f.displayId ?? `#${f.ticketId}`} (${f.signature})`;
}

/** The distinguishable pause reason, naming the failing tickets and their fault signatures. Begins
 *  with {@link BREAKER_REASON_PREFIX} so every surface can recognise a breaker pause. */
export function breakerPauseReason(failures: BreakerFailure[]): string {
  return `${BREAKER_REASON_PREFIX}: ${failures.length} consecutive deterministic failures across distinct tickets — ${failures
    .map(failureLabel)
    .join(', ')}`;
}
