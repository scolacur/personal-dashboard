import type { SystemStatus } from '@dashboard/shared';

/**
 * Nav killswitch state (PD-410) — pure so it can be unit-tested without the Svelte plugin
 * (`apps/web/vitest.config.ts` runs without it; see nav-utils.ts).
 *
 * **The loop has two independent halts, and collapsing them would make the button lie.**
 * `robot.ts` gates first on `isDispatchPaused` (C4 `dispatch_paused`) and then, separately, on
 * `activeSessionLimitHold` (PD-470 / D-063). `setDispatchPaused(db, false)` — what the resume
 * endpoint calls — clears only the first. So during a session-limit hold the loop is not
 * dispatching, but "Resume" would clear a flag that isn't the one blocking it and nothing visible
 * would happen. Hence three modes, not a paused boolean:
 *
 *  - `running`  — dispatching. Offer Pause.
 *  - `paused`   — a human or a system-wide fault stopped it. **Waits for a human.** Offer Resume.
 *  - `holding`  — waiting out a provider session limit. **Ends by itself** at a known time, so
 *                 there is deliberately no button: there is nothing for a human to do.
 */
export type DispatchMode = 'running' | 'paused' | 'holding';

export interface DispatchView {
  mode: DispatchMode;
  /** Short nav label. */
  label: string;
  /** The pause reason, or when the hold lifts. Null when running. */
  detail: string | null;
  /** What the button does, or null when no button should be offered at all. */
  action: 'pause' | 'resume' | null;
  /**
   * True when the loop is BOTH paused and holding. Resuming is still correct — it clears the
   * pause — but it will not re-arm dispatch until the hold expires, and the UI has to say so
   * rather than imply the click was enough.
   */
  resumeBlockedByHold: boolean;
}

/** Wall-clock "5:30 AM". A relative "in 3h" reads as an estimate, and the whole point is that the
 *  provider named a specific time (mirrors SystemStatus.svelte). */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Derive what the nav should show. `now` is passed in (not read from the clock) so an expiring
 * hold is evaluated against the same tick the caller renders with, and so this stays testable.
 */
export function describeDispatch(status: SystemStatus | null, now: number): DispatchView | null {
  if (!status) return null;

  // Re-checked against the caller's clock as well as the server's: an expired hold must read as
  // gone even if a poll is still in flight, exactly as SystemStatus does.
  const holding = status.sessionLimit !== null && status.sessionLimit.until > now;
  const paused = status.dispatch.paused;

  if (paused) {
    return {
      mode: 'paused',
      label: 'Dispatch paused',
      detail: status.dispatch.reason ?? 'paused by human',
      action: 'resume',
      resumeBlockedByHold: holding,
    };
  }

  if (holding) {
    return {
      mode: 'holding',
      label: 'Dispatch holding',
      // Non-null asserted: `holding` is only true when sessionLimit is non-null.
      detail: `resumes ${formatClockTime(status.sessionLimit!.until)}`,
      action: null,
      resumeBlockedByHold: false,
    };
  }

  return {
    mode: 'running',
    label: 'Dispatch running',
    detail: null,
    action: 'pause',
    resumeBlockedByHold: false,
  };
}
