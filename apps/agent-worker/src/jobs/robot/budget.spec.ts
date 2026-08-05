import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { budgetUsage, evaluateBudget, checkBudget, publishBudgetPolicy, type BudgetPolicy } from './budget';
import { ensureRunsTable } from './runs';
import { ensureRobotStateTable } from './state';

const DAY = 24 * 60 * 60_000;
const policy: BudgetPolicy = { windowMs: DAY, turns: 500, tokens: 0 };

function db(): Database.Database {
  const d = new Database(':memory:');
  ensureRunsTable(d);
  ensureRobotStateTable(d);
  return d;
}

/** A finished run, as `finishRun` records one. */
function addRun(
  d: Database.Database,
  { turns, tokens = 0, finishedAt, startedAt }: { turns: number | null; tokens?: number | null; finishedAt: number | null; startedAt?: number },
): void {
  d.prepare(
    `INSERT INTO agent_runs (ticket_id, issue_number, branch, status, turns, tokens, started_at, finished_at)
     VALUES (1, 1, 'robot/1', 'handed-off', ?, ?, ?, ?)`,
  ).run(turns, tokens, startedAt ?? finishedAt ?? 0, finishedAt);
}

describe('budgetUsage (PD-463 window arithmetic)', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
  });

  it('an empty window is zero across the board', () => {
    expect(budgetUsage(d, 0)).toEqual({ turns: 0, tokens: 0, runs: 0 });
  });

  it('sums turns and tokens inside the window', () => {
    addRun(d, { turns: 40, tokens: 1000, finishedAt: 5000 });
    addRun(d, { turns: 12, tokens: 300, finishedAt: 6000 });
    expect(budgetUsage(d, 4000)).toEqual({ turns: 52, tokens: 1300, runs: 2 });
  });

  // The rollover boundary: `since` is inclusive, so a run landing exactly on it still counts. Spend
  // ages out by falling strictly before the window, never by rounding.
  it('includes a run exactly on the boundary and excludes one before it', () => {
    addRun(d, { turns: 10, finishedAt: 5000 });
    addRun(d, { turns: 99, finishedAt: 4999 });
    expect(budgetUsage(d, 5000)).toMatchObject({ turns: 10, runs: 1 });
  });

  it('counts an in-flight run by started_at — spent turns count before the run lands', () => {
    // The exact case a finished_at-only window would miss: a Robot 40 turns into a long run.
    addRun(d, { turns: 40, finishedAt: null, startedAt: 5000 });
    expect(budgetUsage(d, 4000)).toMatchObject({ turns: 40, runs: 1 });
  });

  it('treats null turns/tokens (legacy rows, or a run that never reported) as zero', () => {
    addRun(d, { turns: null, tokens: null, finishedAt: 5000 });
    addRun(d, { turns: 7, tokens: null, finishedAt: 5000 });
    expect(budgetUsage(d, 0)).toEqual({ turns: 7, tokens: 0, runs: 2 });
  });
});

describe('evaluateBudget', () => {
  it('is not breached below the ceiling', () => {
    expect(evaluateBudget({ turns: 499, tokens: 0, runs: 10 }, policy)).toEqual({ breached: false });
  });

  it('breaches AT the ceiling, not only above it', () => {
    const v = evaluateBudget({ turns: 500, tokens: 0, runs: 10 }, policy);
    expect(v.breached).toBe(true);
    expect(v.breached && v.reason).toContain('500 turns');
    expect(v.breached && v.reason).toContain('ceiling 500');
  });

  // A single run can legally spend 50 turns; a ceiling below that would be breached by one run.
  // That is correct behaviour — the ceiling gates the NEXT dispatch, it never kills the run.
  it('a single run larger than the whole ceiling breaches it', () => {
    const tiny: BudgetPolicy = { windowMs: DAY, turns: 10, tokens: 0 };
    expect(evaluateBudget({ turns: 50, tokens: 0, runs: 1 }, tiny).breached).toBe(true);
  });

  it('enforces the token limb independently', () => {
    const tokensOnly: BudgetPolicy = { windowMs: DAY, turns: 0, tokens: 1_000_000 };
    expect(evaluateBudget({ turns: 9999, tokens: 999_999, runs: 1 }, tokensOnly)).toEqual({ breached: false });
    expect(evaluateBudget({ turns: 0, tokens: 1_000_000, runs: 1 }, tokensOnly).breached).toBe(true);
  });

  it('a disabled ceiling (0 or negative) never breaches — pre-PD-463 behaviour', () => {
    const off: BudgetPolicy = { windowMs: DAY, turns: 0, tokens: 0 };
    expect(evaluateBudget({ turns: 10_000, tokens: 10_000_000, runs: 99 }, off)).toEqual({ breached: false });
    const negative: BudgetPolicy = { windowMs: DAY, turns: -1, tokens: -1 };
    expect(evaluateBudget({ turns: 10_000, tokens: 10_000_000, runs: 99 }, negative)).toEqual({ breached: false });
  });
});

describe('checkBudget + publishBudgetPolicy', () => {
  it('spend that has aged out of the window stops counting', () => {
    const d = db();
    const now = 10 * DAY;
    addRun(d, { turns: 600, finishedAt: now - DAY - 1 }); // just outside
    expect(checkBudget(d, policy, now)).toEqual({ breached: false });
    addRun(d, { turns: 600, finishedAt: now - DAY }); // exactly on the boundary
    expect(checkBudget(d, policy, now).breached).toBe(true);
  });

  it('publishes the effective policy for the web process to read', () => {
    const d = db();
    publishBudgetPolicy(d, policy, 1000);
    const row = d.prepare("SELECT value FROM robot_state WHERE key = 'budget_policy'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ windowMs: DAY, turns: 500, tokens: 0 });
  });
});
