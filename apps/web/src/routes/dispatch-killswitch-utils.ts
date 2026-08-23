import type { AgentState, HoldKind, SystemStatus } from '@dashboard/shared';

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
 *  - `holding`  — waiting out a provider session limit or a GitHub rate limit (PD-248).
 *                 **Ends by itself** at a known time, so there is deliberately no button: there is
 *                 nothing for a human to do. The label names WHICH — the remedies differ (a quota
 *                 reset is just a wait; GitHub throttling the loop is worth looking into).
 *  - `maintenance` — a maintenance hold is stopping dispatch (PD-498). Also ends by itself, also no
 *                 button, but unlike a provider hold its length is KNOWN once the window opens, so
 *                 this is the one mode that can honestly show a countdown. Covers BOTH halves of a
 *                 hold: dispatch stops when one is queued, not when the window opens, so a nav that
 *                 only knew about open windows would report "Loop on" all through the drain.
 *
 * **Why maintenance is a mode and not a badge.** It is a fourth independent halt in `robot.ts`, and
 * the nav previously could not see it: `dispatch_paused` was clear, so it said "Dispatch running"
 * while a maintenance-hold pill sat beside it. Both statements were true and together they were
 * nonsense. A mode the nav cannot represent is a mode it will contradict.
 */
export type DispatchMode = 'running' | 'paused' | 'holding' | 'maintenance';

export interface DispatchView {
  mode: DispatchMode;
  /** Short nav label. */
  label: string;
  /** The pause reason, or when the hold lifts. Null when running. */
  detail: string | null;
  /** What the button does, or null when no button should be offered at all. */
  action: 'pause' | 'resume' | null;
  /** Which condition is being waited out, or null when not holding (PD-248). */
  holdKind: HoldKind | null;
  /**
   * Epoch ms this halt is known to end, or null when the end is not knowable.
   *
   * Only a maintenance hold sets this. A session-limit hold has an `until` too, but it is the
   * provider's stated reset and is reported as a wall-clock time rather than counted down — a
   * ticking clock implies a precision that a quota reset does not have.
   */
  endsBy: number | null;
  /**
   * True when the loop is BOTH paused and holding. Resuming is still correct — it clears the
   * pause — but it will not re-arm dispatch until the hold expires, and the UI has to say so
   * rather than imply the click was enough.
   */
  resumeBlockedByHold: boolean;
}

/** What each hold is called in the UI. Deliberately concrete — "holding" alone tells you nothing
 *  about whether anyone needs to act. */
export const HOLD_LABELS: Record<HoldKind, string> = {
  'session-limit': 'Session limit',
  'github-rate-limit': 'GitHub rate limit',
};

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
  // A queued hold has no `endsBy` to expire against — it is stopping dispatch until the coordinator
  // says otherwise, so only the open window gets the lapsed-clock check.
  const maintenance =
    status.maintenanceHold !== null &&
    (status.maintenanceHold.endsBy === null || status.maintenanceHold.endsBy > now);

  if (paused) {
    return {
      mode: 'paused',
      label: 'Dispatch paused',
      detail: status.dispatch.reason ?? 'paused by human',
      action: 'resume',
      // A maintenance hold blocks a resume every bit as much as a provider hold does: clearing the
      // pause is correct but will not re-arm dispatch until the window closes, and the UI must not
      // imply the click was enough.
      resumeBlockedByHold: holding || maintenance,
      holdKind: holding ? status.sessionLimit!.kind : null,
      endsBy: maintenance ? status.maintenanceHold!.endsBy : null,
    };
  }

  if (holding) {
    // Non-null asserted throughout: `holding` is only true when sessionLimit is non-null.
    const kind = status.sessionLimit!.kind;
    return {
      mode: 'holding',
      label: HOLD_LABELS[kind],
      detail: `resumes ${formatClockTime(status.sessionLimit!.until)}`,
      action: null,
      resumeBlockedByHold: false,
      holdKind: kind,
      endsBy: null,
    };
  }

  // Ordered AFTER the provider hold on purpose. Both end by themselves, but a spent quota is the
  // more consequential thing to be told about — a maintenance window is routine and brief.
  if (maintenance) {
    const hold = status.maintenanceHold!;
    const trigger = hold.trigger === 'manual' ? 'started by hand' : 'scheduled';
    return {
      mode: 'maintenance',
      // The label carries the phase because the two are operationally different: during the drain
      // Robots are still working and the wait is open-ended, once open nothing is running and the
      // wait is bounded. One label for both would misdescribe whichever half you are looking at.
      label: hold.phase === 'queued' ? 'Maintenance hold queued' : 'Maintenance hold',
      detail: hold.phase === 'queued' ? `${trigger} — finishing current runs` : trigger,
      action: null,
      resumeBlockedByHold: false,
      holdKind: null,
      endsBy: hold.endsBy,
    };
  }

  return {
    mode: 'running',
    // "Loop on", not "Dispatch running": the loop being armed and a Robot actually running are
    // different facts, and the old label conflated them. What is running is shown by the counts.
    label: 'Loop on',
    detail: null,
    action: 'pause',
    resumeBlockedByHold: false,
    holdKind: null,
    endsBy: null,
  };
}

/**
 * The fleet breakdown shown under the label.
 *
 * **Four counts, not the three "dispatched / working / paused" originally sketched.** "Dispatched"
 * is not an agent state, and at `ROBOT_CONCURRENCY=1` it would only ever duplicate `working`.
 * "Paused" collapses three states with three different remedies. These four each correspond to a
 * real state, so a number here can always be traced to specific tickets.
 */
export interface FleetCounts {
  /** Live runs right now — the number that answers "is anything actually happening". */
  working: number;
  /** Waiting for a slot or a gate. */
  queued: number;
  /** Handed off; a PR is open. */
  inReview: number;
  /** Parked and will not move without a human: stuck, needs-human, awaiting-human. */
  needsYou: number;
}

const NEEDS_YOU_STATES: AgentState[] = ['stuck', 'needs-human', 'awaiting-human'];

export function fleetCounts(status: SystemStatus | null): FleetCounts {
  const n = (state: AgentState): number => status?.sortie?.[state] ?? 0;
  return {
    working: n('working'),
    queued: n('queued'),
    inReview: n('in-review'),
    needsYou: NEEDS_YOU_STATES.reduce((sum, state) => sum + n(state), 0),
  };
}

/**
 * `mm:ss` remaining until `endsBy`, or null once it has passed.
 *
 * Floors at zero rather than going negative: a countdown that has run out should read as finished,
 * and the poll that clears the hold may be a few seconds behind the clock.
 */
export function countdownLabel(endsBy: number | null, now: number): string | null {
  if (endsBy === null) return null;
  const remaining = Math.max(0, endsBy - now);
  const totalSeconds = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
