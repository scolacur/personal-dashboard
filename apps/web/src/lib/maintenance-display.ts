import { HOLD_CADENCE_MS, HOLD_WINDOW_MS, type MaintenanceHold } from '@dashboard/shared';

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
    `One comes due every ${durationLabel(cadenceMs)}, and only opens once every in-flight Robot run has finished — ` +
    `so it may wait. The window stays open up to ${durationLabel(windowMs)}; a scheduled hold closes as soon as its jobs are done.`
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
