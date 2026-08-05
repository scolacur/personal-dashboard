import type Database from 'better-sqlite3';
import { writeState } from './state';

/**
 * The loop-wide budget ceiling (PD-463). Every other spend control the Robot loop has is either
 * **per-ticket** (`maxTurns`, the fault-tier retry caps) or **reactive** (a human notices, or an
 * auth 401 fires after the credential is already dead). A failure mode that stays inside every
 * per-ticket limit but repeats across many tickets had no backstop at all: fifteen tickets each
 * burning a legal 50 turns is 750 turns nobody authorised.
 *
 * This module answers "the loop has spent N turns this period — stop dispatching." It needs no new
 * instrumentation: `agent_runs` already persists `turns` and `tokens` per run, so the window total
 * is a sum over existing rows. What was missing was a ceiling and an enforcement point.
 *
 * Pure arithmetic is separated from the query so the rollover boundaries are exhaustively testable.
 */

export interface BudgetPolicy {
  /** Rolling window, ms. Spend older than `now - windowMs` no longer counts. */
  windowMs: number;
  /** Turn ceiling for the window; 0 (or less) disables the turn limb. */
  turns: number;
  /** Token ceiling for the window; 0 (or less) disables the token limb. Off by default — token
   *  volume per turn swings wildly by model, so a number that is sane today misleads later. */
  tokens: number;
}

/** What the loop has consumed inside the window. */
export interface BudgetUsage {
  turns: number;
  tokens: number;
  /** Runs counted — surfaced so "0 turns" from an empty window reads differently to "0 turns"
   *  from runs that recorded no turn count. */
  runs: number;
}

export type BudgetVerdict = { breached: false } | { breached: true; reason: string };

/**
 * Spend inside the rolling window.
 *
 * Counted by **`finished_at`, falling back to `started_at`** so a long in-flight run's turns
 * (written live by `updateRunProgress`, PD-230) count the moment they are spent rather than only
 * when the run lands. Spend the loop cannot see is exactly what this ceiling exists to catch.
 * Null `turns`/`tokens` (a legacy row, or a run that never reported) contribute 0.
 */
export function budgetUsage(db: Database.Database, since: number): BudgetUsage {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(turns), 0) AS turns, COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS runs
         FROM agent_runs
        WHERE COALESCE(finished_at, started_at) >= ?`,
    )
    .get(since) as { turns: number; tokens: number; runs: number };
  return { turns: row.turns, tokens: row.tokens, runs: row.runs };
}

/** Whether the window's consumption has reached a configured ceiling. A limb set to 0 or less is
 *  off; both off ⇒ never breached (the pre-PD-463 behaviour, byte for byte). */
export function evaluateBudget(usage: BudgetUsage, policy: BudgetPolicy): BudgetVerdict {
  const hours = Math.round(policy.windowMs / 3_600_000);
  if (policy.turns > 0 && usage.turns >= policy.turns) {
    return {
      breached: true,
      reason: `budget ceiling reached: ${usage.turns} turns in the last ${hours}h (ceiling ${policy.turns}) across ${usage.runs} run(s)`,
    };
  }
  if (policy.tokens > 0 && usage.tokens >= policy.tokens) {
    return {
      breached: true,
      reason: `budget ceiling reached: ${usage.tokens} tokens in the last ${hours}h (ceiling ${policy.tokens}) across ${usage.runs} run(s)`,
    };
  }
  return { breached: false };
}

/** Convenience: read the window and judge it in one call. */
export function checkBudget(db: Database.Database, policy: BudgetPolicy, now: number): BudgetVerdict {
  return evaluateBudget(budgetUsage(db, now - policy.windowMs), policy);
}

/** `robot_state` key holding the loop's EFFECTIVE budget policy, for the web process to read. */
export const BUDGET_POLICY_KEY = 'budget_policy';

/**
 * Publish the policy the loop is actually enforcing into `robot_state`, so the board can show
 * consumption against the ceiling. The limits come from the worker's env, which the web process
 * cannot see (the same reason `maxTurns` has a shared default) — so rather than let the two drift,
 * the worker states its own numbers and the server reads them.
 */
export function publishBudgetPolicy(db: Database.Database, policy: BudgetPolicy, now: number = Date.now()): void {
  writeState(db, BUDGET_POLICY_KEY, JSON.stringify(policy), now);
}
