import { describe, it, expect } from 'vitest';
import {
  WEEK_MS,
  buildBugReport,
  buildIntroductionReport,
  buildEpicBurndowns,
  buildRunReport,
  buildVelocityReport,
  isOpenAt,
  percentile,
  reconstructLifecycles,
  severityOf,
  stateAt,
  weekOf,
  weekRange,
  type IntroducedBug,
  type VelocityEventInput,
  type VelocityRunInput,
} from '@dashboard/shared';

/**
 * Epic PD-895 (Velocity) — the pure reconstruction + bucketing in `packages/shared/velocity.ts`.
 * `packages/shared` has no vitest setup of its own (PD-2), so it is covered from here.
 */

const DAY = 24 * 60 * 60 * 1000;
// Monday 2026-11-02 00:00 America/New_York (EST, UTC-5 — DST ended 2026-11-01).
const MON = Date.UTC(2026, 10, 2, 5);

describe('weekOf', () => {
  it('maps every instant of a week to its Monday 00:00 Eastern', () => {
    expect(weekOf(MON)).toBe(MON);
    expect(weekOf(MON + 3 * DAY + 5 * 3600_000)).toBe(MON);
    expect(weekOf(MON + 7 * DAY - 1)).toBe(MON); // Sunday 23:59:59.999
    expect(weekOf(MON + 7 * DAY)).toBe(MON + WEEK_MS);
    expect(weekOf(MON - 1)).toBe(MON - WEEK_MS - 3600_000); // previous week began in EDT
    // Sunday 21:00 Eastern is already Monday in UTC — still the Eastern week.
    expect(weekOf(MON + 6 * DAY + 21 * 3600_000)).toBe(MON);
  });

  it('steps across a DST change without skipping or repeating a week', () => {
    const weeks = weekRange(Date.UTC(2026, 9, 20), Date.UTC(2026, 10, 10));
    expect(weeks.map((w) => new Date(w).toISOString())).toEqual([
      '2026-10-19T04:00:00.000Z',
      '2026-10-26T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
      '2026-11-09T05:00:00.000Z',
    ]);
  });

  it('weekRange is inclusive of both ends', () => {
    expect(weekRange(MON + DAY, MON + 15 * DAY)).toEqual([MON, MON + WEEK_MS, MON + 2 * WEEK_MS]);
  });
});

describe('percentile', () => {
  it('interpolates and handles empty', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBe(4);
  });
});

const ev = (
  ticketId: number,
  type: string,
  at: number,
  to: string | null = null,
): VelocityEventInput => ({
  ticketId,
  type,
  to,
  at,
});

describe('reconstructLifecycles', () => {
  it('counts a completion once when both the Robot and a status change logged it', () => {
    const [l] = reconstructLifecycles(
      [{ id: 1, isEpic: false, assignee: 'robot', createdAt: MON }],
      [
        ev(1, 'created', MON),
        ev(1, 'robot_completed', MON + 2 * DAY),
        ev(1, 'status_changed', MON + 2 * DAY + 5, 'completed'),
      ],
    );
    expect(l.completedAt).toBe(MON + 2 * DAY);
    expect(l.transitions).toEqual([{ at: MON + 2 * DAY, resolved: true, completed: true }]);
  });

  it('keeps the FIRST completion across a reopen, and the ticket is open again after it', () => {
    const [l] = reconstructLifecycles(
      [{ id: 1, isEpic: false, assignee: 'steve', createdAt: MON }],
      [
        ev(1, 'status_changed', MON + 3 * DAY, 'completed'),
        ev(1, 'status_changed', MON + 1 * DAY, 'queue'), // out of order on purpose
        ev(1, 'status_changed', MON + 4 * DAY, 'queue'),
        ev(1, 'status_changed', MON + 9 * DAY, 'completed'),
      ],
    );
    expect(l.completedAt).toBe(MON + 3 * DAY);
    expect(isOpenAt(l, MON + 3.5 * DAY)).toBe(false);
    expect(isOpenAt(l, MON + 5 * DAY)).toBe(true);
    expect(isOpenAt(l, MON + 10 * DAY)).toBe(false);
  });

  it('a closed ticket is resolved but not completed; null assignee buckets as unassigned', () => {
    const [l] = reconstructLifecycles(
      [{ id: 1, isEpic: false, assignee: null, createdAt: MON + DAY }],
      [ev(1, 'status_changed', MON + 2 * DAY, 'closed')],
    );
    expect(l.assignee).toBe('unassigned');
    expect(l.completedAt).toBeNull();
    expect(l.createdAt).toBe(MON + DAY); // falls back to the row when no created event
    expect(isOpenAt(l, MON)).toBe(false); // not yet created
    expect(isOpenAt(l, MON + 1.5 * DAY)).toBe(true);
    expect(isOpenAt(l, MON + 3 * DAY)).toBe(false);
  });
});

describe('buildVelocityReport', () => {
  const lifecycles = reconstructLifecycles(
    [
      { id: 1, isEpic: false, assignee: 'robot', createdAt: MON },
      { id: 2, isEpic: false, assignee: 'steve', createdAt: MON },
      { id: 3, isEpic: true, assignee: null, createdAt: MON },
      { id: 4, isEpic: false, assignee: 'robot', createdAt: MON + 8 * DAY },
      { id: 5, isEpic: false, assignee: null, createdAt: MON - 30 * DAY },
    ],
    [
      ev(1, 'robot_completed', MON + 2 * DAY),
      ev(2, 'status_changed', MON + 4 * DAY, 'completed'),
      ev(3, 'status_changed', MON + 9 * DAY, 'completed'),
      ev(4, 'status_changed', MON + 10 * DAY, 'closed'),
    ],
  );
  const now = MON + 12 * DAY;
  const r = buildVelocityReport(lifecycles, now);

  it('starts at the first completion event and runs to the current week', () => {
    expect(r.startDate).toBe(MON + 2 * DAY);
    expect(r.weeks.map((w) => w.weekStart)).toEqual([MON, MON + WEEK_MS]);
  });

  it('buckets completions by week, assignee and kind', () => {
    expect(r.weeks[0].ticketsCompleted).toEqual({ robot: 1, steve: 1, unassigned: 0 });
    expect(r.weeks[1].epicsCompleted).toEqual({ robot: 0, steve: 0, unassigned: 1 });
    expect(r.totals.ticketsCompleted).toEqual({ robot: 1, steve: 1, unassigned: 0 });
    expect(r.totals.epicsCompleted.unassigned).toBe(1);
  });

  it('burndown: created / resolved per week and open at week end, Epics excluded', () => {
    expect(r.weeks[0]).toMatchObject({ created: 2, resolved: 2 });
    expect(r.weeks[0].open).toEqual({ robot: 0, steve: 0, unassigned: 1 }); // ticket 5
    expect(r.weeks[1]).toMatchObject({ created: 1, resolved: 1 }); // 4 created + closed
    expect(r.totals.openNow).toEqual({ robot: 0, steve: 0, unassigned: 1 });
  });

  it('cycle time: median / p75 days of tickets completed that week', () => {
    expect(r.weeks[0]).toMatchObject({ cycleMedianDays: 3, cycleP75Days: 3.5, cycleSample: 2 });
    expect(r.weeks[1].cycleMedianDays).toBeNull(); // only an Epic completed
  });

  it('honours a from/to window and returns no weeks when there is no history', () => {
    expect(buildVelocityReport(lifecycles, now, { from: MON + 8 * DAY }).weeks).toHaveLength(1);
    const empty = buildVelocityReport([], now);
    expect(empty).toMatchObject({ startDate: null, weeks: [] });
  });
});

describe('buildRunReport', () => {
  const run = (o: Partial<VelocityRunInput>): VelocityRunInput => ({
    ticketId: 1,
    status: 'handed-off',
    faultTier: null,
    turns: 10,
    maxTurns: 50,
    startedAt: MON,
    finishedAt: MON + 30 * 60000,
    ...o,
  });

  it('classifies success / failure / park — ask-human is NOT a failure', () => {
    const r = buildRunReport(
      [
        run({}),
        run({ status: 'error', faultTier: 'transient', ticketId: 2 }),
        run({ status: 'no-verify', ticketId: 2, faultTier: null }),
        run({ status: 'ask-human', ticketId: 3 }),
        run({ status: 'running', ticketId: 4, finishedAt: null, turns: null }),
      ],
      MON + DAY,
    );
    const [w] = r.weeks;
    expect(w).toMatchObject({ runs: 5, succeeded: 1, failed: 2, parked: 1 });
    expect(w.successRate).toBeCloseTo(1 / 4);
    expect(w.faults).toEqual({ transient: 1, deterministic: 0, 'system-wide': 0, none: 1 });
    expect(w).toMatchObject({ ticketsRun: 4, ticketsRetried: 1, retryRate: 0.25 });
    expect(w.meanTurnRatio).toBeCloseTo(0.2);
    expect(w.meanDurationMin).toBeCloseTo(30);
    expect(r.totals).toEqual({ runs: 5, succeeded: 1, failed: 2, parked: 1 });
  });

  it('empty input → empty report', () => {
    expect(buildRunReport([], MON)).toMatchObject({ startDate: null, weeks: [] });
  });
});

describe('stateAt', () => {
  it('tells done from dropped, follows reopens, and upgrades a close that later completes', () => {
    const [l] = reconstructLifecycles(
      [{ id: 1, isEpic: false, assignee: null, createdAt: MON }],
      [
        ev(1, 'status_changed', MON + 1 * DAY, 'closed'),
        ev(1, 'status_changed', MON + 2 * DAY, 'queue'),
        ev(1, 'status_changed', MON + 3 * DAY, 'closed'),
        ev(1, 'status_changed', MON + 4 * DAY, 'completed'),
      ],
    );
    expect(stateAt(l, MON - 1)).toBe('absent');
    expect(stateAt(l, MON + 0.5 * DAY)).toBe('open');
    expect(stateAt(l, MON + 1.5 * DAY)).toBe('dropped');
    expect(stateAt(l, MON + 2.5 * DAY)).toBe('open');
    expect(stateAt(l, MON + 3.5 * DAY)).toBe('dropped');
    expect(stateAt(l, MON + 4.5 * DAY)).toBe('done');
  });
});

describe('buildEpicBurndowns', () => {
  const lifecycles = reconstructLifecycles(
    [
      { id: 10, isEpic: false, assignee: 'robot', createdAt: MON },
      { id: 11, isEpic: false, assignee: 'robot', createdAt: MON },
      { id: 12, isEpic: false, assignee: 'steve', createdAt: MON + 8 * DAY },
      { id: 20, isEpic: false, assignee: null, createdAt: MON },
    ],
    [
      ev(10, 'robot_completed', MON + 2 * DAY),
      ev(11, 'status_changed', MON + 9 * DAY, 'closed'),
      ev(20, 'status_changed', MON + 1 * DAY, 'completed'),
    ],
  );
  const now = MON + 10 * DAY;
  const out = buildEpicBurndowns(
    [
      { id: 1, displayId: 'PD-1', title: 'A', status: 'queue', memberIds: [10, 11, 12] },
      { id: 2, displayId: 'PD-2', title: 'B', status: 'backlog', memberIds: [20] },
      { id: 3, displayId: 'PD-3', title: 'empty', status: 'backlog', memberIds: [] },
    ],
    lifecycles,
    now,
  );

  it('skips memberless Epics and orders by most recent member activity', () => {
    expect(out.map((e) => e.displayId)).toEqual(['PD-1', 'PD-2']);
  });

  it('counts open / done / dropped members at each week end', () => {
    const a = out[0];
    expect(a.weeks.map((w) => [w.open, w.done, w.dropped])).toEqual([
      [1, 1, 0], // week 1: 10 done, 11 open, 12 not created yet
      [1, 1, 1], // week 2: 11 closed (dropped), 12 created and open
    ]);
    expect(a.now).toEqual({ open: 1, done: 1, dropped: 1 });
    expect(a.memberCount).toBe(3);
    expect(a.lastActivity).toBe(MON + 9 * DAY);
  });
});

describe('severityOf', () => {
  it('buckets priority; unset is low', () => {
    expect(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', null, 'none'].map(severityOf)).toEqual([
      'high',
      'high',
      'medium',
      'medium',
      'low',
      'low',
      'low',
      'low',
    ]);
  });
});

describe('buildBugReport', () => {
  const lifecycles = reconstructLifecycles(
    [
      { id: 1, isEpic: false, assignee: 'robot', createdAt: MON },
      { id: 2, isEpic: false, assignee: 'steve', createdAt: MON + DAY },
      { id: 3, isEpic: false, assignee: null, createdAt: MON + 8 * DAY },
    ],
    [
      ev(1, 'robot_completed', MON + 3 * DAY),
      ev(2, 'status_changed', MON + 9 * DAY, 'closed'), // won't fix — not a fix
    ],
  );
  const bugs = [
    { lifecycle: lifecycles[0], priority: 'P1' },
    { lifecycle: lifecycles[1], priority: 'P3' },
    { lifecycle: lifecycles[2], priority: null },
  ];
  const r = buildBugReport(bugs, MON + 10 * DAY);

  it('counts filed / fixed / open by severity per week; a close is not a fix', () => {
    expect(r.weeks).toHaveLength(2);
    expect(r.weeks[0]).toMatchObject({
      filed: { high: 1, medium: 1, low: 0 },
      fixed: { high: 1, medium: 0, low: 0 },
      open: { high: 0, medium: 1, low: 0 },
      medianDaysToFix: 3,
    });
    expect(r.weeks[1]).toMatchObject({
      filed: { high: 0, medium: 0, low: 1 },
      fixed: { high: 0, medium: 0, low: 0 },
      open: { high: 0, medium: 0, low: 1 },
      medianDaysToFix: null,
    });
    expect(r.totals).toEqual({ bugs: 3, fixed: 1, openNow: { high: 0, medium: 0, low: 1 } });
  });

  it('no bugs → empty report', () => {
    expect(buildBugReport([], MON)).toMatchObject({ startDate: null, weeks: [] });
  });
});

describe('buildIntroductionReport', () => {
  const cand = (robot: boolean, at: number) => ({
    sha: `s${at}`,
    prNumber: 1,
    tickets: [],
    robot,
    committedAt: at,
    lines: 3,
  });
  const bug = (
    filedAt: number,
    top: ReturnType<typeof cand> | null,
    status: IntroducedBug['status'] = 'traced',
  ): IntroducedBug => ({
    ticketId: filedAt,
    displayId: null,
    title: '',
    priority: null,
    filedAt,
    fixedAt: filedAt + DAY,
    status,
    top,
    candidates: top ? [top] : [],
  });
  const now = MON + 70 * DAY;
  const bugs = [
    bug(MON + 30 * DAY, cand(false, MON)), // lag 30d
    bug(MON + 40 * DAY, cand(true, MON + 20 * DAY)), // lag 20d
    bug(MON + 50 * DAY, cand(false, MON + 10 * DAY)), // lag 40d
    bug(MON + 5 * DAY, null, 'untraceable'),
    bug(MON + 6 * DAY, null, 'unlinked'),
  ];
  const prs = [
    { prNumber: 1, mergedAt: MON, robot: false },
    { prNumber: 2, mergedAt: MON + 10 * DAY, robot: false },
    { prNumber: 3, mergedAt: MON + 20 * DAY, robot: true },
    { prNumber: 4, mergedAt: MON + 20 * DAY + 3600_000, robot: true }, // same week (MON+21d is a Monday)
    { prNumber: 5, mergedAt: MON + 65 * DAY, robot: false }, // still accumulating — excluded from rates
  ];
  const r = buildIntroductionReport(bugs, prs, now, 123);

  it('counts every status and takes the median introduced→filed lag', () => {
    expect(r.counts).toEqual({ traced: 3, untraceable: 1, unlinked: 1 });
    expect(r.medianLagDays).toBe(30);
    expect(r.accumulatingFrom).toBe(weekOf(now - 30 * DAY));
    expect(r.computedAt).toBe(123);
  });

  it('dates each bug by its top suspect, robot vs hand-built, alongside PRs merged', () => {
    expect(r.weeks[0]).toMatchObject({
      introduced: { robot: 0, human: 1 },
      prsMerged: { robot: 0, human: 1 },
    });
    const robotWeek = r.weeks.find((w) => w.weekStart === weekOf(MON + 20 * DAY))!;
    expect(robotWeek).toMatchObject({
      introduced: { robot: 1, human: 0 },
      prsMerged: { robot: 2, human: 0 },
    });
  });

  it('rates bugs per 100 PRs over settled weeks only', () => {
    expect(r.per100).toEqual({ robot: 50, human: 100 }); // 1 of 2 robot PRs; 2 of 2 settled hand-built PRs
    expect(r.settled).toEqual({ robotPrs: 2, humanPrs: 2, robotBugs: 1, humanBugs: 2 });
  });

  it('is empty, not an error, before the worker has run', () => {
    expect(buildIntroductionReport([], [], now, null)).toMatchObject({
      computedAt: null,
      weeks: [],
      medianLagDays: null,
      accumulatingFrom: null,
      per100: { robot: null, human: null },
    });
  });
});
