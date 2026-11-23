// Velocity metrics (Epic PD-895 — Velocity & internal metrics). Pure reconstruction + weekly
// bucketing over the board's event log, shared by the server aggregates and their tests.
//
// History is events-only (PD-834 Refine round): there is no `completed_at` column, so a
// ticket's lifecycle is replayed from `agent_ticket_events`. The trend honestly starts at the
// first completion event; nothing is backfilled from `updated_at`.

/** Week buckets start Monday 00:00 in Steve's timezone, not UTC — a UTC week would roll over
 *  on Sunday evening. Weeks are 7 calendar days, so across a DST change one is an hour short or long. */
export const VELOCITY_TIMEZONE = 'America/New_York';
/** A nominal week, for windowing math only — use `nextWeek` to step between bucket starts. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function zonedParts(ts: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const get = (type: string) => Number(f.formatToParts(ts).find((p) => p.type === type)?.value);
  return {
    y: get('year'),
    m: get('month') - 1,
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** `tz`'s UTC offset at instant `ts`, in ms (negative west of Greenwich). */
function tzOffset(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s) - (ts - (((ts % 1000) + 1000) % 1000));
}

/** The instant of local midnight on calendar day y-m-d in `tz`. */
function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m, d);
  const first = guess - tzOffset(guess, tz);
  const off = tzOffset(first, tz);
  return guess - off;
}

/** Start (unix ms) of the week (Monday 00:00 in `tz`) containing `ts`. */
export function weekOf(ts: number, tz: string = VELOCITY_TIMEZONE): number {
  const p = zonedParts(ts, tz);
  const weekday = new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay(); // Sun=0
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(Date.UTC(p.y, p.m, p.d) - daysSinceMonday * DAY_MS);
  return zonedMidnight(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate(), tz);
}

/** The week start after `weekStart` (DST-safe: not always exactly WEEK_MS later). */
export function nextWeek(weekStart: number, tz: string = VELOCITY_TIMEZONE): number {
  return weekOf(weekStart + WEEK_MS + 6 * HOUR_MS, tz);
}

/** Every week start from `weekOf(from)` through `weekOf(to)` inclusive. */
export function weekRange(from: number, to: number, tz: string = VELOCITY_TIMEZONE): number[] {
  const out: number[] = [];
  const last = weekOf(to, tz);
  for (let w = weekOf(from, tz); w <= last; w = nextWeek(w, tz)) out.push(w);
  return out;
}

/** Value at percentile `p` (0–1) of `values`, linear interpolation; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/* ── Ticket lifecycle reconstruction ─────────────────────────────────────────────────────── */

/** Who a ticket is assigned to, as a series key. `unassigned` covers a null assignee. */
export type VelocityAssignee = 'robot' | 'steve' | 'unassigned';
export const VELOCITY_ASSIGNEES: readonly VelocityAssignee[] = ['robot', 'steve', 'unassigned'];

export function assigneeBucket(assignee: string | null): VelocityAssignee {
  return assignee === 'robot' || assignee === 'steve' ? assignee : 'unassigned';
}

/** The ticket facts the reconstruction needs (current row state). */
export interface VelocityTicketInput {
  id: number;
  isEpic: boolean;
  assignee: string | null;
  createdAt: number;
}

/** The lifecycle events the reconstruction reads. `to` is `detail.to` for `status_changed`. */
export interface VelocityEventInput {
  ticketId: number;
  type: string;
  to: string | null;
  at: number;
}

/** Statuses that take a ticket off the burndown. `closed` resolves without completing. */
const RESOLVED_STATUSES = new Set(['completed', 'closed']);

export interface TicketLifecycle {
  id: number;
  isEpic: boolean;
  assignee: VelocityAssignee;
  /** The `created` event's time, falling back to the row's `created_at`. */
  createdAt: number;
  /** First completion (`robot_completed`, or `status_changed` → completed); null if never. */
  completedAt: number | null;
  /** Resolution flips in time order: true = resolved (completed/closed), false = reopened. */
  transitions: { at: number; resolved: boolean }[];
}

/**
 * Replay each ticket's events into a lifecycle. A ticket's completion is counted once (its
 * first), whichever path logged it — the Robot logs `robot_completed`, a human status change
 * logs `status_changed`, and a Robot-completed ticket can carry both.
 */
export function reconstructLifecycles(
  tickets: VelocityTicketInput[],
  events: VelocityEventInput[],
): TicketLifecycle[] {
  const byTicket = new Map<number, VelocityEventInput[]>();
  for (const e of events) {
    const list = byTicket.get(e.ticketId);
    if (list) list.push(e);
    else byTicket.set(e.ticketId, [e]);
  }
  return tickets.map((t) => {
    const evs = (byTicket.get(t.id) ?? []).slice().sort((a, b) => a.at - b.at);
    let createdAt = t.createdAt;
    let completedAt: number | null = null;
    let resolved = false;
    const transitions: { at: number; resolved: boolean }[] = [];
    for (const e of evs) {
      if (e.type === 'created') {
        createdAt = e.at;
        continue;
      }
      let nowResolved: boolean | null = null;
      if (e.type === 'robot_completed') {
        nowResolved = true;
        completedAt ??= e.at;
      } else if (e.type === 'status_changed' && e.to) {
        nowResolved = RESOLVED_STATUSES.has(e.to);
        if (e.to === 'completed') completedAt ??= e.at;
      }
      if (nowResolved !== null && nowResolved !== resolved) {
        resolved = nowResolved;
        transitions.push({ at: e.at, resolved });
      }
    }
    return {
      id: t.id,
      isEpic: t.isEpic,
      assignee: assigneeBucket(t.assignee),
      createdAt,
      completedAt,
      transitions,
    };
  });
}

/** Whether a lifecycle is open (created and not resolved) at instant `ts`. */
export function isOpenAt(l: TicketLifecycle, ts: number): boolean {
  if (l.createdAt > ts) return false;
  let resolved = false;
  for (const tr of l.transitions) {
    if (tr.at > ts) break;
    resolved = tr.resolved;
  }
  return !resolved;
}

/* ── Completion / burndown / cycle-time report (PD-859) ──────────────────────────────────── */

export type AssigneeCounts = Record<VelocityAssignee, number>;

export function emptyAssigneeCounts(): AssigneeCounts {
  return { robot: 0, steve: 0, unassigned: 0 };
}

export interface VelocityWeek {
  /** Week start, unix ms (Monday 00:00 America/New_York). */
  weekStart: number;
  /** Tickets (non-Epic) first completed this week, by current assignee. */
  ticketsCompleted: AssigneeCounts;
  /** Epics first completed this week, by current assignee. */
  epicsCompleted: AssigneeCounts;
  /** Burndown, non-Epic tickets: created this week. */
  created: number;
  /** Burndown: resolved (completed or closed) this week; a reopen does not subtract. */
  resolved: number;
  /** Burndown: open at the end of this week (or now, for the current week), by assignee. */
  open: AssigneeCounts;
  /** Cycle time (created → first completion) of non-Epic tickets completed this week, days. */
  cycleMedianDays: number | null;
  cycleP75Days: number | null;
  cycleSample: number;
}

export interface VelocityReport {
  /** Earliest completion event — the honest start of the trend; null when none exist. */
  startDate: number | null;
  generatedAt: number;
  weeks: VelocityWeek[];
  totals: {
    ticketsCompleted: AssigneeCounts;
    epicsCompleted: AssigneeCounts;
    openNow: AssigneeCounts;
  };
}

export interface ReportWindow {
  from?: number | null;
  to?: number | null;
}

/** Clip the default week span [start, now] to an optional `from`/`to` window. */
function windowWeeks(start: number, now: number, win: ReportWindow): number[] {
  const from = Math.max(start, win.from ?? start);
  const to = Math.min(now, win.to ?? now);
  return from > to ? [] : weekRange(from, to);
}

export function buildVelocityReport(
  lifecycles: TicketLifecycle[],
  now: number,
  win: ReportWindow = {},
): VelocityReport {
  const completions = lifecycles.filter((l) => l.completedAt !== null);
  const startDate = completions.length
    ? Math.min(...completions.map((l) => l.completedAt as number))
    : null;

  const totals = {
    ticketsCompleted: emptyAssigneeCounts(),
    epicsCompleted: emptyAssigneeCounts(),
    openNow: emptyAssigneeCounts(),
  };
  const work = lifecycles.filter((l) => !l.isEpic);
  for (const l of completions) {
    (l.isEpic ? totals.epicsCompleted : totals.ticketsCompleted)[l.assignee]++;
  }
  for (const l of work) if (isOpenAt(l, now)) totals.openNow[l.assignee]++;

  if (startDate === null) return { startDate, generatedAt: now, weeks: [], totals };

  const weeks = windowWeeks(startDate, now, win).map((weekStart): VelocityWeek => {
    const weekEnd = nextWeek(weekStart); // exclusive
    const inWeek = (ts: number) => ts >= weekStart && ts < weekEnd;
    const ticketsCompleted = emptyAssigneeCounts();
    const epicsCompleted = emptyAssigneeCounts();
    const cycles: number[] = [];
    for (const l of completions) {
      if (!inWeek(l.completedAt as number)) continue;
      if (l.isEpic) epicsCompleted[l.assignee]++;
      else {
        ticketsCompleted[l.assignee]++;
        cycles.push(((l.completedAt as number) - l.createdAt) / DAY_MS);
      }
    }
    const asOf = Math.min(weekEnd - 1, now);
    const open = emptyAssigneeCounts();
    let created = 0;
    let resolved = 0;
    for (const l of work) {
      if (inWeek(l.createdAt)) created++;
      resolved += l.transitions.filter((tr) => tr.resolved && inWeek(tr.at)).length;
      if (isOpenAt(l, asOf)) open[l.assignee]++;
    }
    return {
      weekStart,
      ticketsCompleted,
      epicsCompleted,
      created,
      resolved,
      open,
      cycleMedianDays: percentile(cycles, 0.5),
      cycleP75Days: percentile(cycles, 0.75),
      cycleSample: cycles.length,
    };
  });

  return { startDate, generatedAt: now, weeks, totals };
}

/* ── Robot-run report (PD-860) ───────────────────────────────────────────────────────────── */

export interface VelocityRunInput {
  ticketId: number;
  status: string;
  faultTier: string | null;
  turns: number | null;
  maxTurns: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export type RunFaultCounts = Record<'transient' | 'deterministic' | 'system-wide' | 'none', number>;

export interface RunWeek {
  weekStart: number;
  /** All runs started this week, including still-running ones. */
  runs: number;
  /** `handed-off` — the run opened a PR. */
  succeeded: number;
  /** `no-verify` + `error`. */
  failed: number;
  /** `ask-human` — a park, neither success nor failure. */
  parked: number;
  /** succeeded / (succeeded + failed + parked); null when nothing finished. */
  successRate: number | null;
  /** Distinct tickets run this week, and how many of them took more than one run. */
  ticketsRun: number;
  ticketsRetried: number;
  retryRate: number | null;
  /** Mean `turns / max_turns` over runs that recorded both. */
  meanTurnRatio: number | null;
  /** Mean `finished_at − started_at` in minutes, finished runs only. */
  meanDurationMin: number | null;
  /** Fault tier of failed runs (`none` = a failure with no tier recorded). */
  faults: RunFaultCounts;
}

export interface RunReport {
  startDate: number | null;
  generatedAt: number;
  weeks: RunWeek[];
  totals: { runs: number; succeeded: number; failed: number; parked: number };
}

const RUN_FAILED = new Set(['no-verify', 'error']);

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildRunReport(
  runs: VelocityRunInput[],
  now: number,
  win: ReportWindow = {},
): RunReport {
  const totals = { runs: runs.length, succeeded: 0, failed: 0, parked: 0 };
  for (const r of runs) {
    if (r.status === 'handed-off') totals.succeeded++;
    else if (RUN_FAILED.has(r.status)) totals.failed++;
    else if (r.status === 'ask-human') totals.parked++;
  }
  if (runs.length === 0) return { startDate: null, generatedAt: now, weeks: [], totals };
  const startDate = Math.min(...runs.map((r) => r.startedAt));

  const weeks = windowWeeks(startDate, now, win).map((weekStart): RunWeek => {
    const weekEnd = nextWeek(weekStart);
    const inWeek = runs.filter((r) => r.startedAt >= weekStart && r.startedAt < weekEnd);
    const succeeded = inWeek.filter((r) => r.status === 'handed-off').length;
    const failedRuns = inWeek.filter((r) => RUN_FAILED.has(r.status));
    const parked = inWeek.filter((r) => r.status === 'ask-human').length;
    const finished = succeeded + failedRuns.length + parked;
    const perTicket = new Map<number, number>();
    for (const r of inWeek) perTicket.set(r.ticketId, (perTicket.get(r.ticketId) ?? 0) + 1);
    const ticketsRetried = [...perTicket.values()].filter((n) => n > 1).length;
    const faults: RunFaultCounts = { transient: 0, deterministic: 0, 'system-wide': 0, none: 0 };
    for (const r of failedRuns) {
      const tier = r.faultTier as keyof RunFaultCounts | null;
      faults[tier && tier in faults ? tier : 'none']++;
    }
    return {
      weekStart,
      runs: inWeek.length,
      succeeded,
      failed: failedRuns.length,
      parked,
      successRate: finished ? succeeded / finished : null,
      ticketsRun: perTicket.size,
      ticketsRetried,
      retryRate: perTicket.size ? ticketsRetried / perTicket.size : null,
      meanTurnRatio: mean(
        inWeek
          .filter((r) => r.turns !== null && r.maxTurns)
          .map((r) => (r.turns as number) / (r.maxTurns as number)),
      ),
      meanDurationMin: mean(
        inWeek
          .filter((r) => r.finishedAt !== null && r.status !== 'running')
          .map((r) => ((r.finishedAt as number) - r.startedAt) / 60000),
      ),
      faults,
    };
  });
  return { startDate, generatedAt: now, weeks, totals };
}
