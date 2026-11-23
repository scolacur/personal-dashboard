import type { AgentState, SystemStatus } from '@dashboard/shared';

/**
 * Pure view helpers shared by the two renderings of `/system-status`: the compact strip
 * (`SystemStatus.svelte`, also inside the `/devops` Agent card) and the full Agent Dashboard
 * (`agent-dashboard/AgentFleet.svelte`, PD-818). Extracted so the two can't drift on what counts as
 * "active", "stale" or "near the ceiling".
 */

/** The `/system-status` route. */
export const SYSTEM_STATUS_URL = '/api/widgets/task-monitor/system-status';

/** Poll interval for both renderings (the Agent Dashboard's idle rate). */
export const REFRESH_MS = 30_000;

/** PD-908: the Agent Dashboard's poll interval while any agent is running, so its turn / token
 *  readouts track the per-turn DB writes. Cheap: the route is synchronous SQLite reads only, and
 *  WAL means a read never blocks the worker's writes. */
export const ACTIVE_REFRESH_MS = 5_000;

/**
 * PD-908: how long until the Agent Dashboard polls again — fast while agents are active, the idle
 * rate otherwise, and `null` (don't poll) while the tab is hidden so a forgotten tab costs nothing.
 * `activeAgents` is read defensively: a server older than PD-819 doesn't send it.
 */
export function nextPollDelay(
  status: Partial<Pick<SystemStatus, 'activeAgents'>> | null,
  hidden: boolean,
): number | null {
  if (hidden) return null;
  return (status?.activeAgents?.length ?? 0) > 0 ? ACTIVE_REFRESH_MS : REFRESH_MS;
}

/** A worker with no heartbeat for >3× its write interval (30s) is treated as down. */
export const STALE_MS = 90_000;

/** Fraction of a budget limb at which it reads as "near" the ceiling. */
export const WARN_FRACTION = 0.8;

// In-flight states worth a live glance (terminal done/wontfix are excluded — the fleet
// view is about active work). Fixed order so chips don't reshuffle between polls.
export const ACTIVE_STATES: AgentState[] = [
  'working',
  'queued',
  'in-review',
  'awaiting-human',
  'checkpoint',
  'needs-human',
  'stuck',
];

/** The active states that currently have at least one ticket, in ACTIVE_STATES order. */
export function activeStatesOf(status: SystemStatus | null): AgentState[] {
  return status ? ACTIVE_STATES.filter((s) => (status.sortie[s] ?? 0) > 0) : [];
}

/** Wall-clock "5:30 AM" for a reset — a relative "in 3h" reads as an estimate, and the whole
 *  point is that the provider named a specific time. */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export interface BudgetLimb {
  label: string;
  near: boolean;
  over: boolean;
}

/** One limb of the budget ceiling, or null when that limb is disabled. */
export function limb(used: number, limit: number | null, unit: string): BudgetLimb | null {
  if (limit === null || limit <= 0) return null;
  const fraction = used / limit;
  return {
    label: `${used.toLocaleString()} / ${limit.toLocaleString()} ${unit}`,
    near: fraction >= WARN_FRACTION,
    over: used >= limit,
  };
}

/** PD-463: the enabled limbs of the loop-wide ceiling (turns, tokens). */
export function budgetLimbsOf(budget: SystemStatus['budget']): BudgetLimb[] {
  if (!budget) return [];
  return [limb(budget.turnsUsed, budget.turnsLimit, 'turns'), limb(budget.tokensUsed, budget.tokensLimit, 'tokens')].filter(
    (l): l is BudgetLimb => l !== null,
  );
}
