import { describe, it, expect } from 'vitest';
import type { SystemStatus } from '@dashboard/shared';
import {
  HOLD_LABELS,
  countdownLabel,
  describeDispatch,
  fleetCounts,
  fleetRows,
  needsYouHref,
  pauseReasonLabel,
} from './dispatch-killswitch-utils';

const NOW = 1_000_000;

function status(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    sortie: {},
    workers: [],
    dispatch: { paused: false, reason: null, since: null },
    sessionLimit: null,
    budget: null,
    githubRateLimit: null,
    maintenanceHold: null,
    needsHuman: [],
    ...over,
  };
}

describe('describeDispatch', () => {
  it('returns null before the first poll lands', () => {
    expect(describeDispatch(null, NOW)).toBeNull();
  });

  it('offers Pause while the loop is running', () => {
    expect(describeDispatch(status(), NOW)).toMatchObject({
      mode: 'running',
      action: 'pause',
      detail: null,
    });
  });

  it('offers Resume when paused, and surfaces the reason', () => {
    const s = status({ dispatch: { paused: true, reason: 'budget ceiling reached', since: 500 } });
    expect(describeDispatch(s, NOW)).toMatchObject({
      mode: 'paused',
      action: 'resume',
      detail: 'budget ceiling reached',
      resumeBlockedByHold: false,
    });
  });

  it('falls back to a reason when the pause recorded none', () => {
    const s = status({ dispatch: { paused: true, reason: null, since: 500 } });
    expect(describeDispatch(s, NOW)?.detail).toBe('Manual pause');
  });

  // The point of the three-mode split. A session-limit hold stops dispatch, but `robot.ts` gates on
  // it SEPARATELY from `dispatch_paused` and the resume endpoint clears only the latter — so a
  // Resume button here would clear the wrong flag and appear to do nothing.
  it('offers NO action while holding for a session limit — the hold clears itself', () => {
    const s = status({ sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'session limit', since: 500 } });
    expect(describeDispatch(s, NOW)).toMatchObject({ mode: 'holding', action: null });
    expect(describeDispatch(s, NOW)?.detail).toMatch(/^resumes /);
  });

  it('treats an expired hold as gone, without waiting for the next poll', () => {
    const s = status({ sessionLimit: { kind: 'session-limit', until: NOW - 1, reason: 'session limit', since: 500 } });
    expect(describeDispatch(s, NOW)?.mode).toBe('running');
  });

  // Both halts at once: resuming is still right, but it does not re-arm dispatch on its own and
  // the UI has to say so rather than imply the click was enough.
  it('flags that Resume will not re-arm while a hold is also active', () => {
    const s = status({
      dispatch: { paused: true, reason: 'auth fault', since: 500 },
      sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'session limit', since: 500 },
    });
    expect(describeDispatch(s, NOW)).toMatchObject({
      mode: 'paused',
      action: 'resume',
      resumeBlockedByHold: true,
    });
  });
});

// PD-248: both holds end by themselves, but they are not the same news. A spent Anthropic quota is
// purely a wait; GitHub throttling the loop means something is hammering the API and is worth
// looking into. A nav that says "session limit" for the second one sends you to the wrong place.
describe('naming which hold is in force (PD-248)', () => {
  it('labels a GitHub rate-limit hold distinctly from a session limit', () => {
    const gh = describeDispatch(
      status({ sessionLimit: { kind: 'github-rate-limit', until: NOW + 60_000, reason: 'HTTP 429', since: 500 } }),
      NOW,
    );
    const session = describeDispatch(
      status({ sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'quota', since: 500 } }),
      NOW,
    );
    expect(gh?.label).toBe(HOLD_LABELS['github-rate-limit']);
    expect(session?.label).toBe(HOLD_LABELS['session-limit']);
    expect(gh?.label).not.toBe(session?.label);
  });

  it('still offers no action for either — neither needs a human', () => {
    for (const kind of ['github-rate-limit', 'session-limit'] as const) {
      const v = describeDispatch(status({ sessionLimit: { kind, until: NOW + 60_000, reason: 'r', since: 500 } }), NOW);
      expect(v).toMatchObject({ mode: 'holding', action: null, holdKind: kind });
    }
  });

  it('reports the hold kind alongside a pause, so "Resume will not re-arm" can say why', () => {
    const v = describeDispatch(
      status({
        dispatch: { paused: true, reason: 'auth fault', since: 500 },
        sessionLimit: { kind: 'github-rate-limit', until: NOW + 60_000, reason: 'HTTP 429', since: 500 },
      }),
      NOW,
    );
    expect(v).toMatchObject({ mode: 'paused', resumeBlockedByHold: true, holdKind: 'github-rate-limit' });
  });

  it('has no hold kind when nothing is holding', () => {
    expect(describeDispatch(status(), NOW)?.holdKind).toBeNull();
  });
});

describe('the maintenance hold as a dispatch mode (PD-498)', () => {
  const hold = (over: Partial<NonNullable<SystemStatus['maintenanceHold']>> = {}) => ({
    id: 1,
    trigger: 'manual' as const,
    phase: 'active' as const,
    startedAt: NOW - 60_000,
    endsBy: NOW + 600_000,
    ...over,
  });

  /** A hold that has stopped dispatch but whose window has not opened — no deadline yet. */
  const queuedHold = (over: Partial<NonNullable<SystemStatus['maintenanceHold']>> = {}) =>
    hold({ phase: 'queued', startedAt: null, endsBy: null, ...over });

  it('reports the hold instead of claiming the loop is dispatching', () => {
    // The bug this fixes: dispatch_paused is clear during a maintenance hold, so the nav said
    // "Dispatch running" beside a maintenance-hold pill. Both true, together nonsense.
    const view = describeDispatch(status({ maintenanceHold: hold() }), NOW)!;
    expect(view.mode).toBe('maintenance');
    expect(view.label).toBe('Maintenance hold');
  });

  it('offers no button — there is nothing for a human to do', () => {
    expect(describeDispatch(status({ maintenanceHold: hold() }), NOW)!.action).toBeNull();
  });

  it('carries an end time, because a maintenance window has a known length', () => {
    expect(describeDispatch(status({ maintenanceHold: hold() }), NOW)!.endsBy).toBe(NOW + 600_000);
  });

  it('says whether the hold was scheduled or started by hand', () => {
    expect(describeDispatch(status({ maintenanceHold: hold({ trigger: 'manual' }) }), NOW)!.detail).toBe('started by hand');
    expect(describeDispatch(status({ maintenanceHold: hold({ trigger: 'scheduled' }) }), NOW)!.detail).toBe('scheduled');
  });

  it('reads as gone the moment it expires, without waiting for a poll', () => {
    const view = describeDispatch(status({ maintenanceHold: hold({ endsBy: NOW - 1 }) }), NOW)!;
    expect(view.mode).toBe('running');
  });

  it('a provider session limit outranks it — the more consequential thing wins the label', () => {
    const view = describeDispatch(
      status({
        maintenanceHold: hold(),
        sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'quota', since: NOW },
      }),
      NOW,
    )!;
    expect(view.mode).toBe('holding');
  });

  it('a pause still wins, and records that resuming will not be enough on its own', () => {
    const view = describeDispatch(
      status({ maintenanceHold: hold(), dispatch: { paused: true, reason: 'by human', since: NOW } }),
      NOW,
    )!;
    expect(view.mode).toBe('paused');
    expect(view.resumeBlockedByHold).toBe(true);
  });

  // The drain is not a footnote: it lasts as long as the longest run in flight, and dispatch is
  // already stopped throughout. A nav that only knew about open windows would say "Loop on".
  it('reports a QUEUED hold as maintenance too — dispatch is already stopped', () => {
    const view = describeDispatch(status({ maintenanceHold: queuedHold() }), NOW)!;
    expect(view.mode).toBe('maintenance');
    expect(view.label).toBe('Maintenance hold queued');
    expect(view.detail).toContain('finishing current runs');
  });

  it('shows no countdown while queued — the window has not started', () => {
    expect(describeDispatch(status({ maintenanceHold: queuedHold() }), NOW)!.endsBy).toBeNull();
  });

  // The lapsed-clock check exists for an open window whose endsBy has passed. A queued hold has no
  // clock at all, and `null > now` is false — so a naive check would drop it back to "Loop on".
  it('does not treat a queued hold as expired for want of an end time', () => {
    expect(describeDispatch(status({ maintenanceHold: queuedHold() }), NOW)!.mode).not.toBe('running');
  });

  it('says a resume will not re-arm during a queued hold either', () => {
    const view = describeDispatch(
      status({ maintenanceHold: queuedHold(), dispatch: { paused: true, reason: 'by human', since: NOW } }),
      NOW,
    )!;
    expect(view.resumeBlockedByHold).toBe(true);
    // ...and with no holdKind, so the note names the maintenance hold rather than a session limit.
    expect(view.holdKind).toBeNull();
  });

  it('does not report a session-limit hold as countable — only maintenance has a known length', () => {
    const view = describeDispatch(
      status({ sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'quota', since: NOW } }),
      NOW,
    )!;
    expect(view.endsBy).toBeNull();
  });
});

describe('fleetCounts', () => {
  it('is all zeroes before the first poll', () => {
    expect(fleetCounts(null)).toEqual({ working: 0, queued: 0, inReview: 0, needsYou: 0 });
  });

  it('counts the states a reader actually asks about', () => {
    const counts = fleetCounts(status({ sortie: { working: 2, queued: 5, 'in-review': 1 } }));
    expect(counts).toMatchObject({ working: 2, queued: 5, inReview: 1 });
  });

  it('rolls the three parked states into one "needs you"', () => {
    // stuck / needs-human / awaiting-human differ in cause but not in what the reader must do:
    // look at it. Three separate nav numbers would be noise.
    expect(fleetCounts(status({ sortie: { stuck: 1, 'needs-human': 2, 'awaiting-human': 3 } })).needsYou).toBe(6);
  });

  it('treats an absent state as zero, not undefined', () => {
    expect(fleetCounts(status({ sortie: {} })).working).toBe(0);
  });
});

describe('countdownLabel', () => {
  it('renders mm:ss', () => {
    expect(countdownLabel(NOW + 125_000, NOW)).toBe('2:05');
  });

  it('pads the seconds', () => {
    expect(countdownLabel(NOW + 61_000, NOW)).toBe('1:01');
  });

  it('floors at zero rather than counting negative', () => {
    // The poll that clears a lapsed hold can be a few seconds behind the clock; "-0:03" reads as
    // broken, "0:00" reads as finished.
    expect(countdownLabel(NOW - 5_000, NOW)).toBe('0:00');
  });

  it('is null when there is nothing to count down to', () => {
    expect(countdownLabel(null, NOW)).toBeNull();
  });
});

describe('pauseReasonLabel', () => {
  it('shortens the loop’s own provenance string', () => {
    // `robot_state` records WHICH surface paused it, which matters in the record and is noise in a
    // header read by the person who clicked the switch.
    expect(pauseReasonLabel('paused by human (nav killswitch)')).toBe('Manual pause');
  });

  it('passes a fault through verbatim — that text IS the warning', () => {
    expect(pauseReasonLabel('auth/credit fault (loop-wide): HTTP 401 Unauthorized')).toBe(
      'auth/credit fault (loop-wide): HTTP 401 Unauthorized',
    );
  });

  it('still says something when the pause recorded no reason', () => {
    expect(pauseReasonLabel(null)).toBe('Manual pause');
  });
});

describe('needsYouHref', () => {
  const t = (id: number) => ({ id, displayId: `PD-${id}`, title: 't', agentState: 'stuck' as const });

  it('goes to the ticket itself when exactly one is parked', () => {
    // The complaint this fixes: the count sent you to the board and left you to find which ticket
    // it meant — the exact trip the number was supposed to save.
    expect(needsYouHref([t(42)], 1)).toBe('/devops/tickets/42');
  });

  it('falls back to the board when several are parked', () => {
    expect(needsYouHref([t(1), t(2)], 2)).toBe('/devops/task-tracker');
  });

  it('goes nowhere when nothing is parked', () => {
    expect(needsYouHref([], 0)).toBeNull();
  });

  // The carried list is capped. If the cap ever sits below the real count, one carried row must not
  // masquerade as "the only one" and send the reader to a ticket that is not the whole story.
  it('does not treat one carried row as the only one when the count disagrees', () => {
    expect(needsYouHref([t(7)], 5)).toBe('/devops/task-tracker');
  });
});

describe('fleetRows', () => {
  it('returns the four states in a fixed order', () => {
    expect(fleetRows(status()).map((r) => r.key)).toEqual(['working', 'queued', 'inReview', 'needsYou']);
  });

  it('carries the counts through', () => {
    const rows = fleetRows(status({ sortie: { working: 2, queued: 5, 'in-review': 1, stuck: 3 } }));
    expect(rows.map((r) => r.count)).toEqual([2, 5, 1, 3]);
  });

  it('gives a zero row no destination — there is nothing to look at', () => {
    expect(fleetRows(status()).every((r) => r.href === null)).toBe(true);
  });

  it('links "needs you" at the ticket when one is parked', () => {
    const rows = fleetRows(
      status({
        sortie: { stuck: 1 },
        needsHuman: [{ id: 99, displayId: 'PD-99', title: 't', agentState: 'stuck' }],
      }),
    );
    expect(rows.find((r) => r.key === 'needsYou')?.href).toBe('/devops/tickets/99');
  });

  it('is all zeroes and no links before the first poll', () => {
    expect(fleetRows(null).every((r) => r.count === 0 && r.href === null)).toBe(true);
  });
});
