import type Database from 'better-sqlite3';
import {
  CONFIG_OVERRIDES_TABLE,
  WORKER_CONFIG_BOOT_KEY,
  WORKER_SETTINGS,
  validateWorkerSettingValue,
  type WorkerConfigBootSnapshot,
  type WorkerSettingDef,
} from '@dashboard/shared';
import type { AgentWorkerConfig } from './config';
import { logger } from './logger';
import { ensureRobotStateTable, writeState } from '../jobs/robot/state';

/**
 * DB overrides for the worker's tunables (PD-1006, D-121).
 *
 * The env var is the boot default; a row in `config_overrides` wins when present. Settings the
 * registry marks `live` are re-read on every pass (`effectiveConfig`), so an override applies with no
 * restart. The rest arm a timer at boot and take their override once, at startup (`startupConfig`).
 *
 * PD-511 (Runtime toggles: enable/disable each agent type + Robot concurrency, without a recreate)
 * reuses this module and table: it adds registry entries and accessors, not a second store.
 */

interface Accessor {
  get(c: AgentWorkerConfig): number;
  set(c: AgentWorkerConfig, v: number): void;
}

function acc(get: (c: AgentWorkerConfig) => number, set: (c: AgentWorkerConfig, v: number) => void): Accessor {
  return { get, set };
}

/** Where each worker-read registry setting lives on `AgentWorkerConfig`. The parity spec checks this
 *  covers every `readBy: 'worker'` entry and that `loadConfig` really reads each env var into it. */
export const CONFIG_ACCESSORS: Record<string, Accessor> = {
  ROBOT_BUDGET_TURNS: acc((c) => c.robot.budgetTurns, (c, v) => (c.robot.budgetTurns = v)),
  ROBOT_BUDGET_TOKENS: acc((c) => c.robot.budgetTokens, (c, v) => (c.robot.budgetTokens = v)),
  ROBOT_BUDGET_WINDOW_MS: acc((c) => c.robot.budgetWindowMs, (c, v) => (c.robot.budgetWindowMs = v)),
  ROBOT_INTERVAL_MS: acc((c) => c.robot.intervalMs, (c, v) => (c.robot.intervalMs = v)),
  ROBOT_PR_POLL_INTERVAL_MS: acc((c) => c.robot.prPollIntervalMs, (c, v) => (c.robot.prPollIntervalMs = v)),
  ROBOT_MAX_TURNS: acc((c) => c.robot.maxTurns, (c, v) => (c.robot.maxTurns = v)),
  CHECKPOINT_WINDOW_TURNS: acc((c) => c.robot.checkpointWindowTurns, (c, v) => (c.robot.checkpointWindowTurns = v)),
  CHECKPOINT_FIRST_WINDOW_TURNS: acc(
    (c) => c.robot.checkpointFirstWindowTurns,
    (c, v) => (c.robot.checkpointFirstWindowTurns = v),
  ),
  CHECKPOINT_TOTAL_TURNS: acc((c) => c.robot.checkpointTotalTurns, (c, v) => (c.robot.checkpointTotalTurns = v)),
  CHECKPOINT_REPEAT_LIMIT: acc((c) => c.robot.checkpointRepeatLimit, (c, v) => (c.robot.checkpointRepeatLimit = v)),
  ROBOT_RETRY_CAP: acc((c) => c.robot.retryCap, (c, v) => (c.robot.retryCap = v)),
  ROBOT_PROMOTE_AFTER: acc((c) => c.robot.promoteAfter, (c, v) => (c.robot.promoteAfter = v)),
  ROBOT_ORPHAN_CAP: acc((c) => c.robot.orphanCap, (c, v) => (c.robot.orphanCap = v)),
  ROBOT_BREAKER_FAILURES: acc((c) => c.robot.breakerFailures, (c, v) => (c.robot.breakerFailures = v)),
  ROBOT_RESTART_BREAKER_COUNT: acc((c) => c.robot.restartBreakerCount, (c, v) => (c.robot.restartBreakerCount = v)),
  ROBOT_RESTART_BREAKER_WINDOW_MS: acc(
    (c) => c.robot.restartBreakerWindowMs,
    (c, v) => (c.robot.restartBreakerWindowMs = v),
  ),
  ROBOT_STALL_THRESHOLD_MS: acc((c) => c.robot.stallThresholdMs, (c, v) => (c.robot.stallThresholdMs = v)),
  ROBOT_SUPERSEDE_CHECK_MS: acc((c) => c.robot.supersedeCheckMs, (c, v) => (c.robot.supersedeCheckMs = v)),
  ROBOT_BACKOFF_BASE_MS: acc((c) => c.robot.backoffBaseMs, (c, v) => (c.robot.backoffBaseMs = v)),
  ROBOT_BACKOFF_MAX_MS: acc((c) => c.robot.backoffMaxMs, (c, v) => (c.robot.backoffMaxMs = v)),
  EVALUATOR_BUDGET_TURNS: acc((c) => c.evaluator.budgetTurns, (c, v) => (c.evaluator.budgetTurns = v)),
  EVALUATOR_BUDGET_TOKENS: acc((c) => c.evaluator.budgetTokens, (c, v) => (c.evaluator.budgetTokens = v)),
  EVALUATOR_BUDGET_WINDOW_MS: acc((c) => c.evaluator.budgetWindowMs, (c, v) => (c.evaluator.budgetWindowMs = v)),
  EVALUATOR_INTERVAL_MS: acc((c) => c.evaluator.intervalMs, (c, v) => (c.evaluator.intervalMs = v)),
  EVALUATOR_MAX_ROUNDS: acc((c) => c.evaluator.maxRounds, (c, v) => (c.evaluator.maxRounds = v)),
  EVALUATOR_ADOPT_IDLE_MS: acc((c) => c.evaluator.adoptIdleMs, (c, v) => (c.evaluator.adoptIdleMs = v)),
  AGENT_WORKER_REFINE_INTERVAL_MS: acc((c) => c.refineIntervalMs, (c, v) => (c.refineIntervalMs = v)),
  AGENT_WORKER_REFINE_MAX_TURNS: acc((c) => c.refineMaxTurns, (c, v) => (c.refineMaxTurns = v)),
  REFINE_OPEN_CAP: acc((c) => c.refineAutostart.openCap, (c, v) => (c.refineAutostart.openCap = v)),
  AGENT_WORKER_AUDIT_INTERVAL_MS: acc((c) => c.auditIntervalMs, (c, v) => (c.auditIntervalMs = v)),
  CONFLICT_RESOLVER_INTERVAL_MS: acc(
    (c) => c.conflictResolver.intervalMs,
    (c, v) => (c.conflictResolver.intervalMs = v),
  ),
  VISUAL_CAPTURE_INTERVAL_MS: acc((c) => c.visual.intervalMs, (c, v) => (c.visual.intervalMs = v)),
  SZZ_INTERVAL_MS: acc((c) => c.szz.intervalMs, (c, v) => (c.szz.intervalMs = v)),
  AGENT_WORKER_PULL_INTERVAL_MS: acc((c) => c.pullIntervalMs, (c, v) => (c.pullIntervalMs = v)),
  MAINTENANCE_HOLD_POLL_MS: acc((c) => c.maintenance.pollMs, (c, v) => (c.maintenance.pollMs = v)),
};

const WORKER_DEFS: readonly WorkerSettingDef[] = WORKER_SETTINGS.filter((d) => d.readBy === 'worker');

/**
 * Every override row, key → raw TEXT value. Empty when the table does not exist yet: the server's
 * schema bootstrap creates it, and a worker that boots first must run on env values, not crash.
 */
export function readConfigOverrides(db: Database.Database): Map<string, string> {
  try {
    const rows = db.prepare(`SELECT key, value FROM ${CONFIG_OVERRIDES_TABLE}`).all() as { key: string; value: string }[];
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    return new Map();
  }
}

/** Invalid rows already warned about, so a bad override logs once rather than every pass. */
const warned = new Set<string>();

function applyOverrides(
  db: Database.Database,
  base: AgentWorkerConfig,
  include: (def: WorkerSettingDef) => boolean,
): AgentWorkerConfig {
  const overrides = readConfigOverrides(db);
  if (overrides.size === 0) return base;
  let out: AgentWorkerConfig | null = null;
  for (const def of WORKER_DEFS) {
    if (!include(def)) continue;
    const raw = overrides.get(def.key);
    if (raw === undefined) continue;
    const accessor = CONFIG_ACCESSORS[def.key];
    if (!accessor) continue;
    // The server validated it on write; re-checked here because the bounds may have moved since, and
    // an out-of-range cap (a 0 retry cap, say) is exactly what the bounds exist to stop.
    const v = validateWorkerSettingValue(def, raw);
    if (!v.ok) {
      const tag = `${def.key}=${raw}`;
      if (!warned.has(tag)) {
        warned.add(tag);
        logger.warn({ key: def.key, value: raw, reason: v.reason }, 'config: ignoring an invalid override — using the env value');
      }
      continue;
    }
    out ??= structuredClone(base);
    accessor.set(out, v.value);
  }
  return out ?? base;
}

/**
 * The config one pass should run with: `base` plus every **live** override (D-121). Call it at the
 * top of each pass that reads a live setting; it never mutates `base`, so a cleared override falls
 * straight back to the env value on the next pass.
 */
export function effectiveConfig(db: Database.Database, base: AgentWorkerConfig): AgentWorkerConfig {
  return applyOverrides(db, base, (def) => def.live);
}

/** The config the worker starts with: env values plus the **restart-only** overrides present at boot.
 *  Live settings are left at their env values here — `effectiveConfig` layers those on per pass. */
export function startupConfig(db: Database.Database, boot: AgentWorkerConfig): AgentWorkerConfig {
  return applyOverrides(db, boot, (def) => !def.live);
}

/** Every override applied — for one-shot entry points (the deploy drain) that run a single pass. */
export function fullyEffectiveConfig(db: Database.Database, boot: AgentWorkerConfig): AgentWorkerConfig {
  return effectiveConfig(db, startupConfig(db, boot));
}

/** Build the boot snapshot: each worker setting's env/default value and what the worker started with. */
export function workerConfigBootSnapshot(
  boot: AgentWorkerConfig,
  started: AgentWorkerConfig,
  env: NodeJS.ProcessEnv,
  now: number,
): WorkerConfigBootSnapshot {
  const values: WorkerConfigBootSnapshot['values'] = {};
  for (const def of WORKER_DEFS) {
    const accessor = CONFIG_ACCESSORS[def.key];
    if (!accessor) continue;
    const raw = env[def.key];
    values[def.key] = {
      value: accessor.get(boot),
      source: raw !== undefined && raw.trim() !== '' ? 'env' : 'default',
      applied: accessor.get(started),
    };
  }
  return { publishedAt: now, values };
}

/** Publish the boot snapshot into `robot_state` (PD-1006), the same way `capacity_policy` is: the web
 *  process cannot read this container's env, so the worker states its own numbers. */
export function publishWorkerConfigBoot(
  db: Database.Database,
  boot: AgentWorkerConfig,
  started: AgentWorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  ensureRobotStateTable(db);
  writeState(db, WORKER_CONFIG_BOOT_KEY, JSON.stringify(workerConfigBootSnapshot(boot, started, env, now)), now);
}
