import {
  HOLD_CADENCE_MS,
  HOLD_WINDOW_MS,
  type MaintenanceHold,
  type MaintenanceHoldStatus,
} from '@dashboard/shared';

/**
 * Display helpers for the maintenance-hold section (PD-498).
 *
 * Pure functions in their own file so the copy that explains the hold — the part most likely to
 * drift from what the coordinator actually does — is unit-testable rather than buried in markup.
 */

/** Human duration for a span of ms, at the granularity the hold cares about. */
export function durationLabel(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = mins / 60;
  const rounded = Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/**
 * The sentence under the section heading, explaining when a hold happens.
 *
 * Built from the shared constants rather than written out, so the page cannot claim a cadence the
 * coordinator does not keep — the exact drift that hid the missing glossary for weeks (PD-496).
 */
export function holdExplainer(cadenceMs = HOLD_CADENCE_MS, windowMs = HOLD_WINDOW_MS): string {
  return (
    `A maintenance hold pauses Robot dispatch so jobs can safely change shared files. ` +
    `One is queued every ${durationLabel(cadenceMs)}, no matter what. ` +
    `From the moment it is queued no further Robots are dispatched; the Robots already working are ` +
    `allowed to finish, and the hold opens as soon as none are left. ` +
    `It then runs for up to ${durationLabel(windowMs)}, ending sooner if its jobs finish first.`
  );
}


/** "about 7 minutes" / "under a minute" — deliberately vague, because the window closes early when
 *  its jobs finish and a precise "6:42" would be a promise the coordinator does not make. */
export function approxRemainingLabel(endsBy: number, now: number): string {
  const remaining = Math.max(0, endsBy - now);
  if (remaining < 60_000) return 'under a minute';
  return `about ${durationLabel(remaining)}`;
}

/**
 * What to tell someone who just queued a ticket while a maintenance hold is stopping dispatch.
 *
 * Null when nothing is holding — the caller shows no toast at all.
 *
 * **Why this is worth saying at all:** queueing a ticket normally means a Robot picks it up within
 * a tick. During a hold it does not, and every visible signal (the card moved, the board saved)
 * says it worked. Without this the only available reading is that the loop is broken.
 *
 * The two phases get different copy because the waits are different in kind: a queued hold is
 * waiting on runs that are still going and has no deadline, an open one has a bounded window.
 */
export function queuedDuringHoldNotice(
  hold: MaintenanceHoldStatus | null,
  now: number,
  label = 'this ticket',
): string | null {
  if (!hold) return null;
  const trigger = hold.trigger === 'manual' ? 'manual' : 'scheduled';
  if (hold.phase === 'queued') {
    return (
      `Osiris has a ${trigger} maintenance hold queued, so no further Robots are being dispatched. ` +
      `The Robots already working will finish, then the hold runs. ` +
      `A Robot will be dispatched to work on ${label} once it is over.`
    );
  }
  const remaining = hold.endsBy === null ? null : approxRemainingLabel(hold.endsBy, now);
  return (
    `Osiris is currently in a ${trigger} maintenance hold. During this time no Robots can be dispatched. ` +
    `A Robot will be dispatched to work on ${label} when the hold is over` +
    (remaining === null ? '.' : ` — ${remaining}.`)
  );
}

export type HoldPhase = 'active' | 'queued' | 'completed' | 'abandoned';

/** Short label for a hold's state, for the log and the nav pill. */
export function holdStatusLabel(hold: MaintenanceHold): string {
  switch (hold.status) {
    case 'active':
      return 'Holding dispatch';
    case 'queued':
      return 'Queued — waiting for runs to finish';
    case 'completed':
      return 'Completed';
    case 'abandoned':
      return 'Abandoned';
  }
}

/** How long a hold held dispatch, or null when it never started or has not ended. */
export function holdDurationMs(hold: MaintenanceHold): number | null {
  if (hold.startedAt === null || hold.endedAt === null) return null;
  return hold.endedAt - hold.startedAt;
}

/**
 * Why the "Run now" button is disabled, or null when it is enabled.
 *
 * Returned as a message rather than a boolean so the tooltip and the disabled state cannot
 * disagree — one source for both.
 */
export function runNowDisabledReason(activeHold: MaintenanceHold | null): string | null {
  if (activeHold) return null;
  return 'Only runs during an active maintenance hold — start one above, or wait for the daily hold.';
}

/**
 * Why "Start maintenance hold" is disabled, or null when it is enabled.
 *
 * Same one-source-for-both rule as {@link runNowDisabledReason}: the tooltip and the disabled state
 * are derived from one function so they cannot drift apart.
 */
export function startHoldDisabledReason(activeHold: MaintenanceHold | null, queuedHold: MaintenanceHold | null): string | null {
  if (activeHold) return 'A maintenance hold is already open.';
  if (queuedHold) return 'A maintenance hold is already queued — it opens once the running Robots finish.';
  return null;
}
