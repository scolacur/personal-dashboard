// Worker tunables registry (PD-1006, D-121).
//
// One entry per "set to taste" setting the Dev Ops Configuration page (`/devops/configure`) shows
// and lets Steve override: budgets, poll intervals, caps and thresholds. The page, the server's
// validation and the agent-worker all read THIS list, so a setting cannot be editable in one place
// and ignored in another.
//
// Precedence (D-121): effective value = DB override ?? env var ?? code default. The env var stays the
// boot default; a row in `config_overrides` wins when present. Same shape as PD-511 (Runtime
// toggles: enable/disable each agent type + Robot concurrency, without a recreate), which adds its
// own entries to this registry and its own rows to the same table rather than building a second one.
//
// Deliberately NOT here, ever: secrets and tokens, paths, the repo, bot identity, proxy, public URLs.
// Models belong to PD-315 ([Task Monitor] Add ability to switch which Coding Agent the Robot uses via a
// Settings-page GUI); enable flags and ROBOT_CONCURRENCY to PD-511.

import {
  AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT,
  AUTO_QUEUE_QUEUE_DEPTH_FACTOR,
  AUTO_QUEUE_REVIEW_WIP_LIMIT,
  CHECKPOINT_FIRST_WINDOW_TURNS_DEFAULT,
  CHECKPOINT_TOTAL_TURNS_DEFAULT,
  CHECKPOINT_WINDOW_TURNS_DEFAULT,
  ROBOT_MAX_TURNS_DEFAULT,
} from './task-monitor';

export type WorkerSettingUnit = 'count' | 'ms' | 'turns' | 'tokens';

export type WorkerSettingGroup = 'robot' | 'evaluator' | 'refine' | 'audit' | 'auto-queue' | 'background';

/** Display order + labels of the page's sections. */
export const WORKER_SETTING_GROUPS: readonly { id: WorkerSettingGroup; label: string }[] = [
  { id: 'robot', label: 'Robot' },
  { id: 'evaluator', label: 'Evaluator' },
  { id: 'refine', label: 'Refine' },
  { id: 'audit', label: 'Audit / Ticket Audit' },
  { id: 'auto-queue', label: 'Auto-queue' },
  { id: 'background', label: 'Background jobs' },
];

export interface WorkerSettingDef {
  /** The env var name. Also the override's key in `config_overrides` and in the API path. */
  key: string;
  label: string;
  group: WorkerSettingGroup;
  unit: WorkerSettingUnit;
  /** The code default used when the env var is unset. Integer, like every value here. */
  default: number;
  /** Inclusive bounds an override must sit inside. Env values are not checked against them. */
  min: number;
  max: number;
  description: string;
  /** True when an override applies on the next pass with no worker restart. False: the value arms a
   *  timer at boot, so an override "applies on worker restart". */
  live: boolean;
  /** Which process reads the env var: the agent-worker (`config.ts`) or the web server
   *  (`auto-queue.ts`). It decides where the boot value comes from. */
  readBy: 'worker' | 'server';
}

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `EVALUATOR_MAX_ROUNDS`'s default. Mirrors the worker's `MAX_EVALUATION_ROUNDS`; the registry
 *  parity spec fails if the two drift. */
const EVALUATOR_MAX_ROUNDS_DEFAULT = 2;

export const WORKER_SETTINGS: readonly WorkerSettingDef[] = [
  // ── Robot ───────────────────────────────────────────────────────────────────
  { key: 'ROBOT_BUDGET_TURNS', label: 'Budget: turns', group: 'robot', unit: 'turns', default: 500, min: 0, max: 20_000, live: true, readBy: 'worker',
    description: 'Loop-wide turn ceiling per budget window. Reaching it stops new dispatch. 0 turns the limit off.' },
  { key: 'ROBOT_BUDGET_TOKENS', label: 'Budget: tokens', group: 'robot', unit: 'tokens', default: 0, min: 0, max: 1_000_000_000, live: true, readBy: 'worker',
    description: 'Loop-wide token ceiling per budget window. 0 (the default) turns the limit off.' },
  { key: 'ROBOT_BUDGET_WINDOW_MS', label: 'Budget window', group: 'robot', unit: 'ms', default: DAY, min: HOUR, max: 7 * DAY, live: true, readBy: 'worker',
    description: 'Rolling window the Robot budget is counted over.' },
  { key: 'ROBOT_INTERVAL_MS', label: 'Queue poll interval', group: 'robot', unit: 'ms', default: 15 * SEC, min: 5 * SEC, max: 10 * MIN, live: false, readBy: 'worker',
    description: 'How often the Robot loop looks at the Queue for tickets to dispatch.' },
  { key: 'ROBOT_PR_POLL_INTERVAL_MS', label: 'PR state poll interval', group: 'robot', unit: 'ms', default: 3 * MIN, min: 30 * SEC, max: HOUR, live: true, readBy: 'worker',
    description: 'How often in-review PRs are checked for reviews, merges and conflicts.' },
  { key: 'ROBOT_MAX_TURNS', label: 'Legacy max turns', group: 'robot', unit: 'turns', default: ROBOT_MAX_TURNS_DEFAULT, min: 5, max: 500, live: true, readBy: 'worker',
    description: 'No longer caps a Robot run (the progress check does). Still the scale Refine estimates a ticket’s turn ceiling against.' },
  { key: 'CHECKPOINT_WINDOW_TURNS', label: 'Progress-check window', group: 'robot', unit: 'turns', default: CHECKPOINT_WINDOW_TURNS_DEFAULT, min: 5, max: 200, live: true, readBy: 'worker',
    description: 'Turns between progress checks on a running Robot.' },
  { key: 'CHECKPOINT_FIRST_WINDOW_TURNS', label: 'First progress-check window', group: 'robot', unit: 'turns', default: CHECKPOINT_FIRST_WINDOW_TURNS_DEFAULT, min: 5, max: 400, live: true, readBy: 'worker',
    description: 'Turns before the first progress check: longer, so orientation is not judged as a stall.' },
  { key: 'CHECKPOINT_TOTAL_TURNS', label: 'Episode turn cap', group: 'robot', unit: 'turns', default: CHECKPOINT_TOTAL_TURNS_DEFAULT, min: 10, max: 2_000, live: true, readBy: 'worker',
    description: 'Hard turn cap for one ticket episode, across auto-continues and retries.' },
  { key: 'CHECKPOINT_REPEAT_LIMIT', label: 'Repeat tripwire', group: 'robot', unit: 'count', default: 4, min: 2, max: 50, live: true, readBy: 'worker',
    description: 'How often the same tool call or error may repeat in one window before the run is parked.' },
  { key: 'ROBOT_RETRY_CAP', label: 'Retry cap', group: 'robot', unit: 'count', default: 3, min: 0, max: 20, live: true, readBy: 'worker',
    description: 'Transient-fault retries one ticket gets before it parks.' },
  { key: 'ROBOT_PROMOTE_AFTER', label: 'Promote to deterministic after', group: 'robot', unit: 'count', default: 2, min: 1, max: 20, live: true, readBy: 'worker',
    description: 'Identical-signature repeats that turn a transient fault into a deterministic one (park).' },
  { key: 'ROBOT_ORPHAN_CAP', label: 'Orphan cap', group: 'robot', unit: 'count', default: 3, min: 1, max: 20, live: true, readBy: 'worker',
    description: 'Worker-restart orphans one ticket may collect before it parks.' },
  { key: 'ROBOT_BREAKER_FAILURES', label: 'Circuit breaker', group: 'robot', unit: 'count', default: 3, min: 0, max: 50, live: true, readBy: 'worker',
    description: 'Consecutive deterministic failures across distinct tickets that pause the loop. 0 turns the breaker off.' },
  { key: 'ROBOT_RESTART_BREAKER_COUNT', label: 'Restart breaker: restarts', group: 'robot', unit: 'count', default: 4, min: 1, max: 50, live: true, readBy: 'worker',
    description: 'Unclean worker restarts that left orphaned runs, within the window, that pause dispatch.' },
  { key: 'ROBOT_RESTART_BREAKER_WINDOW_MS', label: 'Restart breaker: window', group: 'robot', unit: 'ms', default: 6 * HOUR, min: 10 * MIN, max: 7 * DAY, live: true, readBy: 'worker',
    description: 'Window the restart breaker counts unclean restarts over.' },
  { key: 'ROBOT_STALL_THRESHOLD_MS', label: 'Stall threshold', group: 'robot', unit: 'ms', default: 2 * HOUR, min: 10 * MIN, max: DAY, live: true, readBy: 'worker',
    description: 'A run still `running` after this long is treated as orphaned and reclaimed. Also bounds a maintenance or deploy drain.' },
  { key: 'ROBOT_SUPERSEDE_CHECK_MS', label: 'Supersede check', group: 'robot', unit: 'ms', default: 2 * MIN, min: 0, max: HOUR, live: true, readBy: 'worker',
    description: 'How often a running rework checks whether its PR merged, closed or was pushed to. 0 turns it off.' },
  { key: 'ROBOT_BACKOFF_BASE_MS', label: 'Backoff: first step', group: 'robot', unit: 'ms', default: MIN, min: SEC, max: HOUR, live: true, readBy: 'worker',
    description: 'First transient-retry delay; doubles per attempt up to the backoff maximum.' },
  { key: 'ROBOT_BACKOFF_MAX_MS', label: 'Backoff: maximum', group: 'robot', unit: 'ms', default: 15 * MIN, min: MIN, max: DAY, live: true, readBy: 'worker',
    description: 'Ceiling on the transient-retry delay.' },

  // ── Evaluator ───────────────────────────────────────────────────────────────
  { key: 'EVALUATOR_BUDGET_TURNS', label: 'Budget: turns', group: 'evaluator', unit: 'turns', default: 200, min: 0, max: 20_000, live: true, readBy: 'worker',
    description: 'The Evaluator’s own turn ceiling per window. Reaching it stops PR reviews until the window rolls. 0 turns the limit off.' },
  { key: 'EVALUATOR_BUDGET_TOKENS', label: 'Budget: tokens', group: 'evaluator', unit: 'tokens', default: 0, min: 0, max: 1_000_000_000, live: true, readBy: 'worker',
    description: 'The Evaluator’s token ceiling per window. 0 (the default) turns the limit off.' },
  { key: 'EVALUATOR_BUDGET_WINDOW_MS', label: 'Budget window', group: 'evaluator', unit: 'ms', default: DAY, min: HOUR, max: 7 * DAY, live: true, readBy: 'worker',
    description: 'Rolling window the Evaluator budget is counted over.' },
  { key: 'EVALUATOR_INTERVAL_MS', label: 'Poll interval', group: 'evaluator', unit: 'ms', default: MIN, min: 10 * SEC, max: HOUR, live: false, readBy: 'worker',
    description: 'How often the Evaluator looks for PRs to review.' },
  { key: 'EVALUATOR_MAX_ROUNDS', label: 'Review round cap', group: 'evaluator', unit: 'count', default: EVALUATOR_MAX_ROUNDS_DEFAULT, min: 1, max: 10, live: true, readBy: 'worker',
    description: 'Times one PR may be sent back for rework before the Evaluator stops and leaves it to you.' },
  { key: 'EVALUATOR_ADOPT_IDLE_MS', label: 'Adopt after idle', group: 'evaluator', unit: 'ms', default: 30 * MIN, min: MIN, max: 7 * DAY, live: true, readBy: 'worker',
    description: 'How long a sent-back session PR must go without a push before the Robot takes it over.' },

  // ── Refine ──────────────────────────────────────────────────────────────────
  { key: 'AGENT_WORKER_REFINE_INTERVAL_MS', label: 'Poll interval', group: 'refine', unit: 'ms', default: 5 * SEC, min: SEC, max: 5 * MIN, live: false, readBy: 'worker',
    description: 'How often the worker checks for Refine turns to answer.' },
  { key: 'AGENT_WORKER_REFINE_MAX_TURNS', label: 'Max turns per reply', group: 'refine', unit: 'turns', default: 30, min: 5, max: 200, live: true, readBy: 'worker',
    description: 'Hard turn ceiling for one Refine reply. Applies to the next reply.' },
  { key: 'REFINE_OPEN_CAP', label: 'Auto-start open cap', group: 'refine', unit: 'count', default: 15, min: 1, max: 100, live: true, readBy: 'worker',
    description: 'Most Refine sessions auto-start keeps open at once.' },

  // ── Audit / Ticket Audit ────────────────────────────────────────────────────
  { key: 'AGENT_WORKER_AUDIT_INTERVAL_MS', label: 'Poll interval', group: 'audit', unit: 'ms', default: 30 * SEC, min: 5 * SEC, max: HOUR, live: false, readBy: 'worker',
    description: 'How often the worker checks for requested Ticket Audit runs.' },

  // ── Auto-queue (read by the web server) ─────────────────────────────────────
  { key: 'AUTO_QUEUE_QUEUE_DEPTH_FACTOR', label: 'Queue depth factor', group: 'auto-queue', unit: 'count', default: AUTO_QUEUE_QUEUE_DEPTH_FACTOR, min: 0, max: 20, live: true, readBy: 'server',
    description: 'The promoter stops while dispatchable Queue tickets reach Robot concurrency × this.' },
  { key: 'AUTO_QUEUE_REVIEW_WIP_LIMIT', label: 'Review WIP limit', group: 'auto-queue', unit: 'count', default: AUTO_QUEUE_REVIEW_WIP_LIMIT, min: 0, max: 50, live: true, readBy: 'server',
    description: 'The promoter stops while this many Robot PRs await review.' },
  { key: 'AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT', label: 'Epic in-flight limit', group: 'auto-queue', unit: 'count', default: AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT, min: 0, max: 20, live: true, readBy: 'server',
    description: 'Members of one Epic that may be in flight before the promoter skips that Epic.' },

  // ── Background jobs ─────────────────────────────────────────────────────────
  { key: 'CONFLICT_RESOLVER_INTERVAL_MS', label: 'Conflict resolver interval', group: 'background', unit: 'ms', default: 5 * MIN, min: MIN, max: DAY, live: true, readBy: 'worker',
    description: 'How often conflicting PRs are checked for a mechanical resolve.' },
  { key: 'VISUAL_CAPTURE_INTERVAL_MS', label: 'Visual capture interval', group: 'background', unit: 'ms', default: 2 * MIN, min: MIN, max: HOUR, live: true, readBy: 'worker',
    description: 'How often Robot UI PRs are checked for screenshots to take.' },
  { key: 'SZZ_INTERVAL_MS', label: 'SZZ interval', group: 'background', unit: 'ms', default: HOUR, min: 5 * MIN, max: 7 * DAY, live: false, readBy: 'worker',
    description: 'How often fixed bugs are blamed back to the PR that introduced them.' },
  { key: 'AGENT_WORKER_PULL_INTERVAL_MS', label: 'Checkout pull interval', group: 'background', unit: 'ms', default: 5 * MIN, min: 30 * SEC, max: HOUR, live: false, readBy: 'worker',
    description: 'How often the worker pulls its read-only grounding checkout.' },
  { key: 'MAINTENANCE_HOLD_POLL_MS', label: 'Maintenance coordinator poll', group: 'background', unit: 'ms', default: MIN, min: 5 * SEC, max: HOUR, live: false, readBy: 'worker',
    description: 'How often the maintenance-hold coordinator advances its state machine.' },
];

const BY_KEY = new Map(WORKER_SETTINGS.map((d) => [d.key, d] as const));

export function workerSettingDef(key: string): WorkerSettingDef | undefined {
  return BY_KEY.get(key);
}

/** `robot_state` key the worker publishes its boot snapshot under (PD-1006): the env/default value of
 *  every worker-read setting, and the value it actually started with. Same precedent as
 *  `capacity_policy` — the web process cannot read the worker's env. */
export const WORKER_CONFIG_BOOT_KEY = 'worker_config_boot';

/** The overrides table (D-121). One row per overridden setting. `value` is TEXT so PD-511's boolean
 *  toggles fit the same table. Created by the server's schema bootstrap. */
export const CONFIG_OVERRIDES_TABLE = 'config_overrides';

export interface WorkerConfigBootEntry {
  /** The env value, or the code default when the env var was unset. */
  value: number;
  source: 'env' | 'default';
  /** What the worker actually started with: `value`, or a restart-only override present at boot. */
  applied: number;
}

export interface WorkerConfigBootSnapshot {
  publishedAt: number;
  values: Record<string, WorkerConfigBootEntry>;
}

export type WorkerSettingValidation = { ok: true; value: number } | { ok: false; reason: string };

/**
 * Validate an override for `def`: an integer inside the registry bounds. Accepts a number or a numeric
 * string (the DB stores TEXT). The reason is shown on the page as-is, so it names the setting.
 */
export function validateWorkerSettingValue(def: WorkerSettingDef, raw: unknown): WorkerSettingValidation {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return { ok: false, reason: `${def.key} must be a number.` };
  if (!Number.isInteger(n)) return { ok: false, reason: `${def.key} must be a whole number.` };
  if (n < def.min || n > def.max) {
    return { ok: false, reason: `${def.key} must be between ${def.min} and ${def.max} (got ${n}).` };
  }
  return { ok: true, value: n };
}

export type WorkerSettingSource = 'override' | 'env' | 'default';

/** Precedence (D-121): override ?? env ?? code default. `boot` is null when the reading process has
 *  not reported its env value (a worker that has not booted since this shipped). */
export function resolveWorkerSetting(
  def: WorkerSettingDef,
  boot: { value: number; source: 'env' | 'default' } | null,
  override: number | null,
): { value: number; source: WorkerSettingSource } {
  if (override !== null) return { value: override, source: 'override' };
  if (boot) return { value: boot.value, source: boot.source };
  return { value: def.default, source: 'default' };
}

/** One row of `GET /api/widgets/task-monitor/worker-config`. */
export interface WorkerConfigEntry {
  key: string;
  label: string;
  group: WorkerSettingGroup;
  unit: WorkerSettingUnit;
  description: string;
  min: number;
  max: number;
  live: boolean;
  readBy: 'worker' | 'server';
  default: number;
  /** The env/default value the reading process booted with; null when the worker has not reported. */
  boot: number | null;
  bootSource: 'env' | 'default' | null;
  override: number | null;
  overrideUpdatedAt: number | null;
  effective: number;
  source: WorkerSettingSource;
  /** A restart-only setting whose effective value differs from what the running worker started with. */
  pendingRestart: boolean;
}

export interface WorkerConfigResponse {
  entries: WorkerConfigEntry[];
  /** When the worker last published its boot snapshot; null if it never has. */
  workerBootAt: number | null;
}
