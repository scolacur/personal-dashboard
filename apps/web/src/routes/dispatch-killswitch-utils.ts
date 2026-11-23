import type { AgentState, HoldKind, SystemStatus } from '@dashboard/shared';
import { AGENT_WORKER_HEARTBEAT_STALE_MS } from '@dashboard/shared';
import { formatRelativeTime } from './deploy-status-utils';

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
  /**
   * True when the `agent-worker` heartbeat is stale or missing (t1010). Intent (the halts above) is
   * not liveness: the loop said "On" through a 20-minute crash-loop because `dispatch_paused` was
   * clear while no worker was alive to act on it. Shown ALONGSIDE the on/off state, never instead of
   * it — the toggle still records intent so a human can pause before the worker returns. Judged by
   * the shared `AGENT_WORKER_HEARTBEAT_STALE_MS`, the same threshold SystemStatus and the auto-queue
   * capacity check use.
   */
  workerOffline: boolean;
  /** Unix ms of the agent-worker's last heartbeat, or null when no row exists at all. Drives the
   *  "last seen Nm ago" detail; a missing row has no age to name. */
  workerLastSeen: number | null;
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
/**
 * The pause reason, as something worth reading in a nav.
 *
 * The loop stores `paused by human (nav killswitch)` so a later reader of `robot_state` knows which
 * surface did it. That provenance matters in the record and is noise in the header — the person
 * reading the nav is the person who clicked it. Anything the loop raised on itself is passed
 * through verbatim, because that text is the whole content of the warning.
 */
export function pauseReasonLabel(reason: string | null): string {
  if (reason === null) return 'Manual pause';
  // t974 (D-107): the circuit breaker stores a long "circuit-breaker: N consecutive … (t1, t2)"
  // reason so the Site Status readout can show the full detail; the nav only needs the gist. Both
  // surfaces thus make the breaker pause visible — distinguished from a manual pause or an auth fault.
  if (/circuit-breaker/i.test(reason)) return 'Circuit breaker tripped';
  return /paused by human/i.test(reason) ? 'Manual pause' : reason;
}

/** The agent-worker's heartbeat identity in `status.workers` — the one process whose liveness
 *  decides whether the loop can act on its intent (t1010). */
const AGENT_WORKER = 'agent-worker';

/**
 * Whether the agent-worker is alive, by the SAME staleness threshold SystemStatus and the
 * auto-queue capacity check already use (`AGENT_WORKER_HEARTBEAT_STALE_MS`). A MISSING row counts as
 * offline: no beacon at all is not a healthy worker. `now` is passed in so this is evaluated against
 * the tick the caller renders with, exactly like the hold checks.
 */
export function agentWorkerLiveness(
  status: SystemStatus | null,
  now: number,
): { offline: boolean; lastSeen: number | null } {
  const beat = status?.workers.find((w) => w.worker === AGENT_WORKER) ?? null;
  if (!beat) return { offline: true, lastSeen: null };
  return { offline: now - beat.lastSeen > AGENT_WORKER_HEARTBEAT_STALE_MS, lastSeen: beat.lastSeen };
}

/**
 * The nav's On/Off text, with worker-offline shown ALONGSIDE it, never instead of it (t1010). The
 * toggle still records intent while the worker is down, so only the label changes: "On" becomes
 * "On · worker offline", "Off" becomes "Off · worker offline".
 */
export function loopStateLabel(view: DispatchView): string {
  const base = view.mode === 'paused' ? 'Off' : 'On';
  return view.workerOffline ? `${base} · worker offline` : base;
}

/**
 * The detail line shown when the agent-worker is offline — the warning Steve lacked when the worker
 * crash-looped for 20 minutes under a green "On" (t1010). Names how long ago the worker last beat so
 * "stale" is legible; a missing row has no age to name. Null when the worker is alive.
 */
export function workerOfflineDetail(view: DispatchView, now: number): string | null {
  if (!view.workerOffline) return null;
  if (view.workerLastSeen === null) return 'No worker heartbeat — nothing is running';
  return `Worker last seen ${formatRelativeTime(view.workerLastSeen, now)} — nothing is running`;
}

export function describeDispatch(status: SystemStatus | null, now: number): DispatchView | null {
  if (!status) return null;

  const worker = agentWorkerLiveness(status, now);

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
      detail: pauseReasonLabel(status.dispatch.reason),
      action: 'resume',
      // A maintenance hold blocks a resume every bit as much as a provider hold does: clearing the
      // pause is correct but will not re-arm dispatch until the window closes, and the UI must not
      // imply the click was enough.
      resumeBlockedByHold: holding || maintenance,
      holdKind: holding ? status.sessionLimit!.kind : null,
      endsBy: maintenance ? status.maintenanceHold!.endsBy : null,
      workerOffline: worker.offline,
      workerLastSeen: worker.lastSeen,
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
      workerOffline: worker.offline,
      workerLastSeen: worker.lastSeen,
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
      workerOffline: worker.offline,
      workerLastSeen: worker.lastSeen,
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
    workerOffline: worker.offline,
    workerLastSeen: worker.lastSeen,
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
/** One row of the fleet box: a count, what it is called, and where it goes. */
export interface FleetRow {
  key: 'working' | 'queued' | 'inReview' | 'needsYou';
  label: string;
  count: number;
  /** Where clicking it goes, or null when there is nothing worth navigating to. */
  href: string | null;
}

/**
 * The fleet box, as rows rather than a bag of numbers.
 *
 * Built here rather than in markup so the destination of each row is testable — "N needs you" that
 * lands on an unfiltered board is the bug this exists to fix, and a template cannot be asserted on.
 *
 * `needsHuman` carries identities, so with exactly ONE parked ticket the row links to that ticket.
 * With several there is no single right answer and the board is the honest destination.
 */
export function fleetRows(status: SystemStatus | null): FleetRow[] {
  const c = fleetCounts(status);
  const parked = status?.needsHuman ?? [];
  return [
    { key: 'working', label: 'working', count: c.working, href: c.working > 0 ? '/devops/task-tracker' : null },
    { key: 'queued', label: 'queued', count: c.queued, href: c.queued > 0 ? '/devops/task-tracker' : null },
    { key: 'inReview', label: 'in review', count: c.inReview, href: c.inReview > 0 ? '/devops/task-tracker' : null },
    {
      key: 'needsYou',
      label: 'needs you',
      count: c.needsYou,
      href: needsYouHref(parked, c.needsYou),
    },
  ];
}

/**
 * Where "needs you" should go.
 *
 * One parked ticket → that ticket's detail page, which is where you can actually answer it. More
 * than one → the board, because picking one of several would be arbitrary. None → nowhere.
 *
 * Guards on the COUNT as well as the list because the list is capped: if the cap ever sits below
 * the real number, a single carried row must not masquerade as "the only one".
 */
export function needsYouHref(parked: SystemStatus['needsHuman'], count: number): string | null {
  if (count <= 0) return null;
  // The detail route is keyed by DISPLAY id (`tickets.find(t => t.displayId === id)`), not the row
  // id — linking `id` sent "1 needs you" to /devops/tickets/987, a page that reports "not found".
  // A ticket with no display id has no detail page to land on, so it falls back to the board.
  if (count === 1 && parked.length === 1 && parked[0].displayId) return `/devops/tickets/${parked[0].displayId}`;
  return '/devops/task-tracker';
}

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

const NEEDS_YOU_STATES: AgentState[] = ['stuck', 'needs-human', 'awaiting-human', 'checkpoint'];

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
