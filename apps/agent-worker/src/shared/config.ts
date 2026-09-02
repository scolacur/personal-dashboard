import path from 'node:path';
import { ROBOT_MAX_TURNS_DEFAULT } from '@dashboard/shared';

/**
 * agent-worker configuration (D-044, D-045). All env-driven so the same image runs in
 * the egress-hardened container and locally in dev. Secrets (ANTHROPIC_API_KEY,
 * GITHUB_READ_TOKEN) live in the agent-worker's OWN env file — never the web process.
 *
 * Shared across all jobs (refine, audit, …); per-job knobs live alongside each job.
 */
export interface AgentWorkerConfig {
  /** Opus by default — the worker plans well and asks the right questions (D-044). */
  model: string;
  /** `owner/repo` for the read-only grounding checkout. */
  githubRepo: string;
  /** READ-ONLY GitHub token used only to clone/pull the grounding checkout. */
  githubReadToken: string;
  /** Persistent read-only checkout the agent grounds against (not ephemeral). */
  checkoutDir: string;
  /** Shared dashboard SQLite file — the same DB the web server owns. */
  dataDir: string;
  /** How often to `git pull` the grounding checkout (ms). */
  pullIntervalMs: number;
  /** How often to poll the shared DB for pending Refine turns (ms). */
  refineIntervalMs: number;
  /**
   * Hard per-turn ceiling for a Refine session (PD-618).
   *
   * There was none: `refineOptions` set no `maxTurns` at all, so one turn could run unbounded. The
   * Robot has had `maxTurns` on every run since PD-432; Refine's only use of `robot.maxTurns` was
   * feeding it into the system prompt so the agent could ESTIMATE a ticket's ceiling — a different
   * thing that reads like a cap at a glance.
   *
   * Lower than the Robot's default on purpose. A refine turn is one reply to one human message: read
   * some files, think, answer. It is not a coding run, and a turn that has taken 30 of these is not
   * converging.
   */
  refineMaxTurns: number;
  /** How often to poll the shared DB for `requested` audit runs to claim (ms). */
  auditIntervalMs: number;
  /** Squid proxy URL when egress-hardened; empty in local dev (direct egress). */
  httpsProxy: string;
  /** The Robot loop (D-055, PD-342) — the in-house dispatcher. Off by default. */
  robot: RobotConfig;
  /** The Evaluator (PD-487, D-076) — post-hand-off PR review. Off by default. */
  evaluator: EvaluatorConfig;
  /** The decision-numbering cycle (PD-498, D-078) — deterministic, no LLM. Off by default. */
  maintenance: MaintenanceConfig;
}

/**
 * Config for the maintenance-hold coordinator (D-081, D-082, D-085).
 *
 * Renamed from `NumberingConfig` by PD-560, along with its env vars: the flag used to be
 * `DECISION_CONSOLIDATION_JOB_ENABLED` because consolidation was the only job, and that job is gone.
 * What it actually gates — and always did — is the coordinator that opens holds.
 *
 * Off by default, like the Robot loop and the Evaluator. A hold suspends dispatch, which is not
 * something an image should start doing merely by being deployed.
 */
export interface MaintenanceConfig {
  enabled: boolean;
  /** How often the coordinator advances the hold state machine. Not the hold cadence — that is
   *  HOLD_CADENCE_MS in shared, because the UI has to state it too. */
  pollMs: number;
}

export function loadMaintenanceConfig(env: NodeJS.ProcessEnv): MaintenanceConfig {
  return {
    enabled: env.MAINTENANCE_HOLD_ENABLED === '1' || env.MAINTENANCE_HOLD_ENABLED === 'true',
    pollMs: Number(env.MAINTENANCE_HOLD_POLL_MS ?? 60_000),
  };
}

/**
 * Config for the **Evaluator** (PD-487, [[D-076]]): reviews a handed-off Robot PR against its
 * ticket. Off by default, like the Robot loop — it is a new autonomous spender, and the deploy
 * that turns it on should be a deliberate act rather than a side effect of shipping the code.
 *
 * Its budget knobs are **separate from the Robot's on purpose**, not merely for tuning: the whole
 * premise of the ticket is that evaluation spend must not be confused with the spend it is judging.
 */
export interface EvaluatorConfig {
  /** Master switch — no evaluation happens unless true (default off). */
  enabled: boolean;
  /**
   * The Evaluator's model, deliberately its OWN setting rather than inheriting `model`.
   *
   * Steve's call (2026-08-12): Opus always. Redundancy detection is whole-codebase judgement, which
   * is exactly where a weaker model produces confident misses — and a false `revise` costs a full
   * rework cycle on both sides. Decoupled from `AGENT_WORKER_MODEL` so lowering the worker default
   * for cost cannot silently downgrade the reviewer.
   */
  model: string;
  /** How often to look for handed-off PRs needing evaluation (ms). */
  intervalMs: number;
  /** Rolling window for the Evaluator's own ceiling (ms, default 24h). */
  budgetWindowMs: number;
  /** Turn ceiling per window; 0 disables. Lower than the Robot's — an evaluation is one read-only
   *  pass over a diff, so a high number here means something is wrong, not something is busy. */
  budgetTurns: number;
  /** Token ceiling per window; 0 disables (the default), same reasoning as the Robot's. */
  budgetTokens: number;
}

/**
 * Config for the **Robot loop** (D-055, PD-342): the `robot` job that dispatches queued
 * tickets. It polls `queue` tickets, opens a git worktree per
 * ticket, and runs a write-enabled coding session (a **Robot**) that hands off a PR. All
 * env-driven; the whole loop is inert unless `dispatchEnabled` is true, so the image ships
 * with the loop dark until a deploy flips it on (C6).
 */
export interface RobotConfig {
  /** Master switch — the loop does nothing unless true (default off). C6 flips it on. */
  dispatchEnabled: boolean;
  /**
   * Dispatch scope (`ROBOT_ALLOWLIST`), post-cutover semantics (C6/PD-347):
   *   - `'all'`  — unset/empty ⇒ every eligible `queue` ticket dispatches (normal operation,
   *                still bounded by `dispatchEnabled` + `concurrency`). This is the go-live default.
   *   - `'none'` — the literal `NONE` (or a garbage value) ⇒ dispatch nothing: a per-allowlist
   *                killswitch that halts new work without touching `dispatchEnabled`.
   *   - `number[]` — an explicit id list ⇒ only those tickets (the prove-on-one / prove-on-N gate).
   */
  allowlist: number[] | 'all' | 'none';
  /** Max Robots in flight at once (PILOT default 1, the Robot loop's max-concurrent-agents cap). */
  concurrency: number;
  /** How often to poll `queue` for dispatchable tickets (ms). */
  intervalMs: number;
  /** Parent dir for per-ticket worktrees (`<dir>/robot-<n>`); on the persistent /data volume. */
  worktreesDir: string;
  /** WRITE-scoped GitHub token (bot PAT, public_repo) the Robot uses to push + open PRs.
   *  Distinct from the read-only grounding token; the coding session gets it as GH_TOKEN. */
  writeToken: string;
  /** git author identity stamped on the Robot's commits. */
  botName: string;
  botEmail: string;
  /** uid/gid the coding subprocess is dropped to (privilege-split, D-055). undefined ⇒ no
   *  drop (local dev). In the container the loop runs privileged and the coding uid has no
   *  read access to dashboard.db, structurally enforcing D-039. */
  codingUid?: number;
  codingGid?: number;
  /** Home dir for the dropped coding uid. When the uid is dropped, the coding subprocess must
   *  NOT inherit the loop's HOME (root's — unreadable to it); git/gh/npm write their config +
   *  cache here instead. Matches the `robot` user's home created in the image. */
  codingHome: string;
  /** Hard turn ceiling for one coding session (the Robot loop's max-turns cap). */
  maxTurns: number;
  /** Fault-tier retry guardrail (D-055, PD-343 / C2). Consumed by faults.ts as its `FaultPolicy`. */
  retryCap: number;
  /** Identical-signature repeats that promote a transient fault to deterministic (park). */
  promoteAfter: number;
  /** First transient-retry backoff step (ms); doubles per attempt up to `backoffMaxMs`. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** In-process stall watchdog (C5/PD-346): a `working` ticket whose run has been `running` longer
   *  than this is an orphan (process died mid-run) — closed + re-queued/parked. Default 2h
   *  (the in-progress staleness threshold, carried over from the retired sortie-watchdog.yml's 120m).
   *  A healthy run finishes in minutes. */
  stallThresholdMs: number;
  /** How often the loop polls each in-review PR's review/merge state for rework (C5/PD-346). The
   *  dispatch loop ticks far faster (`intervalMs`); this throttles the GitHub API hit to its own
   *  slower cadence. Default 3 min. */
  prPollIntervalMs: number;
  /** Loop-wide budget ceiling (PD-463) — the backstop for spend that stays inside every per-ticket
   *  limit but repeats across tickets. Rolling window in ms (default 24h). */
  budgetWindowMs: number;
  /** Turn ceiling per window; 0 disables. Default 500 ≈ ten tickets at the 50-turn per-run cap —
   *  comfortably above a normal day, low enough that a runaway loop stops the same day it starts. */
  budgetTurns: number;
  /** Token ceiling per window; 0 disables (the default). Tokens are the honest measure of spend,
   *  but tokens-per-turn swings by model, so this stays opt-in rather than shipping a number that
   *  quietly goes wrong after a model change. */
  budgetTokens: number;
}

/** Parse an env value as an integer, or undefined when unset/blank/invalid. */
function optInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * Parse `ROBOT_ALLOWLIST` into the dispatch scope (C6/PD-347). Unset/empty ⇒ `'all'` (go-live
 * default: dispatch everything eligible). The literal `NONE` ⇒ `'none'` (killswitch). Otherwise
 * "429,431" → [429, 431]; empties are filtered first so a trailing comma / blank segment doesn't
 * coerce to 0 (Number('') === 0). A non-empty value that yields NO valid ids fails safe to `'none'`
 * — a typo'd allowlist blocks rather than silently opening the floodgates.
 */
function parseAllowlist(raw: string | undefined): number[] | 'all' | 'none' {
  const v = (raw ?? '').trim();
  if (v === '') return 'all';
  if (v.toUpperCase() === 'NONE') return 'none';
  const ids = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));
  return ids.length > 0 ? ids : 'none';
}

export function loadRobotConfig(env: NodeJS.ProcessEnv): RobotConfig {
  return {
    dispatchEnabled: env.ROBOT_DISPATCH_ENABLED === '1' || env.ROBOT_DISPATCH_ENABLED === 'true',
    allowlist: parseAllowlist(env.ROBOT_ALLOWLIST),
    concurrency: Number(env.ROBOT_CONCURRENCY ?? 1),
    intervalMs: Number(env.ROBOT_INTERVAL_MS ?? 15_000),
    worktreesDir: env.ROBOT_WORKTREES_DIR ?? '/data/robot-worktrees',
    writeToken: env.ROBOT_GITHUB_TOKEN ?? '',
    botName: env.ROBOT_BOT_NAME ?? 'sortie-bot-55',
    botEmail: env.ROBOT_BOT_EMAIL ?? '297784052+sortie-bot-55@users.noreply.github.com',
    codingUid: optInt(env.ROBOT_CODING_UID),
    codingGid: optInt(env.ROBOT_CODING_GID),
    codingHome: env.ROBOT_CODING_HOME ?? '/home/robot',
    // Default from @dashboard/shared so the board's denominator (PD-230) and the loop's real cap
    // cannot drift in code. An env override here is NOT visible to the web process.
    maxTurns: Number(env.ROBOT_MAX_TURNS ?? ROBOT_MAX_TURNS_DEFAULT),
    retryCap: Number(env.ROBOT_RETRY_CAP ?? 3),
    promoteAfter: Number(env.ROBOT_PROMOTE_AFTER ?? 2),
    backoffBaseMs: Number(env.ROBOT_BACKOFF_BASE_MS ?? 60_000),
    backoffMaxMs: Number(env.ROBOT_BACKOFF_MAX_MS ?? 15 * 60_000),
    stallThresholdMs: Number(env.ROBOT_STALL_THRESHOLD_MS ?? 2 * 60 * 60_000),
    prPollIntervalMs: Number(env.ROBOT_PR_POLL_INTERVAL_MS ?? 3 * 60_000),
    budgetWindowMs: Number(env.ROBOT_BUDGET_WINDOW_MS ?? 24 * 60 * 60_000),
    budgetTurns: Number(env.ROBOT_BUDGET_TURNS ?? 500),
    budgetTokens: Number(env.ROBOT_BUDGET_TOKENS ?? 0),
  };
}

export function loadEvaluatorConfig(env: NodeJS.ProcessEnv): EvaluatorConfig {
  return {
    enabled: env.EVALUATOR_ENABLED === '1' || env.EVALUATOR_ENABLED === 'true',
    // Not `env.AGENT_WORKER_MODEL` — see EvaluatorConfig.model.
    model: env.EVALUATOR_MODEL ?? 'claude-opus-4-8',
    intervalMs: Number(env.EVALUATOR_INTERVAL_MS ?? 60_000),
    budgetWindowMs: Number(env.EVALUATOR_BUDGET_WINDOW_MS ?? 24 * 60 * 60_000),
    budgetTurns: Number(env.EVALUATOR_BUDGET_TURNS ?? 200),
    budgetTokens: Number(env.EVALUATOR_BUDGET_TOKENS ?? 0),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentWorkerConfig {
  return {
    model: env.AGENT_WORKER_MODEL ?? 'claude-opus-4-8',
    githubRepo: env.AGENT_WORKER_GITHUB_REPO ?? 'scolacur/personal-dashboard',
    githubReadToken: env.GITHUB_READ_TOKEN ?? '',
    checkoutDir: env.AGENT_WORKER_CHECKOUT_DIR ?? '/data/agent-worker-checkout',
    dataDir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    pullIntervalMs: Number(env.AGENT_WORKER_PULL_INTERVAL_MS ?? 5 * 60_000),
    refineIntervalMs: Number(env.AGENT_WORKER_REFINE_INTERVAL_MS ?? 5_000),
    refineMaxTurns: Number(env.AGENT_WORKER_REFINE_MAX_TURNS ?? 30),
    auditIntervalMs: Number(env.AGENT_WORKER_AUDIT_INTERVAL_MS ?? 30_000),
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? '',
    robot: loadRobotConfig(env),
    evaluator: loadEvaluatorConfig(env),
    maintenance: loadMaintenanceConfig(env),
  };
}

export function dbPathFor(config: AgentWorkerConfig): string {
  return path.join(config.dataDir, 'dashboard.db');
}
