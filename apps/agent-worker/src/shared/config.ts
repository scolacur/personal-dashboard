import path from 'node:path';

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
  /** How often to poll the shared DB for `requested` audit runs to claim (ms). */
  auditIntervalMs: number;
  /** Squid proxy URL when egress-hardened; empty in local dev (direct egress). */
  httpsProxy: string;
  /** The Robot loop (D-055, PD-342) — the in-house Sortie replacement. Off by default. */
  robot: RobotConfig;
}

/**
 * Config for the **Robot loop** (D-055, PD-342): the `robot` job that replaces the
 * third-party Sortie dispatcher. It polls `robot_queue` tickets, opens a git worktree per
 * ticket, and runs a write-enabled coding session (a **Robot**) that hands off a PR. All
 * env-driven; the whole loop is inert unless `dispatchEnabled` is true, so the image ships
 * with Sortie still primary until cutover (C6).
 */
export interface RobotConfig {
  /** Master switch — the loop does nothing unless true (default off). C6 flips it on. */
  dispatchEnabled: boolean;
  /** Prove-on-one gate: only these ticket ids may dispatch. Empty ⇒ nothing dispatches,
   *  even when enabled — a second safety catch during bring-up. */
  allowlist: number[];
  /** Max Robots in flight at once (PILOT default 1, mirrors Sortie's max_concurrent_agents). */
  concurrency: number;
  /** How often to poll `robot_queue` for dispatchable tickets (ms). */
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
  /** Hard turn ceiling for one coding session (mirrors Sortie's max_turns). */
  maxTurns: number;
  /** Fault-tier retry guardrail (D-055, PD-343 / C2). Consumed by faults.ts as its `FaultPolicy`. */
  retryCap: number;
  /** Identical-signature repeats that promote a transient fault to deterministic (park). */
  promoteAfter: number;
  /** First transient-retry backoff step (ms); doubles per attempt up to `backoffMaxMs`. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** In-process stall watchdog (C5/PD-346): a `working` ticket whose run has been `running` longer
   *  than this is an orphan (process died mid-run) — closed + re-queued/parked. Default 2h (matches
   *  sortie-watchdog's 120m in-progress threshold). A healthy run finishes in minutes. */
  stallThresholdMs: number;
  /** How often the loop polls each in-review PR's review/merge state for rework (C5/PD-346). The
   *  dispatch loop ticks far faster (`intervalMs`); this throttles the GitHub API hit to its own
   *  slower cadence. Default 3 min. */
  prPollIntervalMs: number;
}

/** Parse an env value as an integer, or undefined when unset/blank/invalid. */
function optInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

export function loadRobotConfig(env: NodeJS.ProcessEnv): RobotConfig {
  return {
    dispatchEnabled: env.ROBOT_DISPATCH_ENABLED === '1' || env.ROBOT_DISPATCH_ENABLED === 'true',
    // "429,431" → [429, 431]; blank ⇒ []. Filter empties first so a trailing comma / blank
    // segment doesn't coerce to 0 (Number('') === 0).
    allowlist: (env.ROBOT_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n)),
    concurrency: Number(env.ROBOT_CONCURRENCY ?? 1),
    intervalMs: Number(env.ROBOT_INTERVAL_MS ?? 15_000),
    worktreesDir: env.ROBOT_WORKTREES_DIR ?? '/data/robot-worktrees',
    writeToken: env.ROBOT_GITHUB_TOKEN ?? '',
    botName: env.ROBOT_BOT_NAME ?? 'sortie-bot-55',
    botEmail: env.ROBOT_BOT_EMAIL ?? '297784052+sortie-bot-55@users.noreply.github.com',
    codingUid: optInt(env.ROBOT_CODING_UID),
    codingGid: optInt(env.ROBOT_CODING_GID),
    codingHome: env.ROBOT_CODING_HOME ?? '/home/robot',
    maxTurns: Number(env.ROBOT_MAX_TURNS ?? 50),
    retryCap: Number(env.ROBOT_RETRY_CAP ?? 3),
    promoteAfter: Number(env.ROBOT_PROMOTE_AFTER ?? 2),
    backoffBaseMs: Number(env.ROBOT_BACKOFF_BASE_MS ?? 60_000),
    backoffMaxMs: Number(env.ROBOT_BACKOFF_MAX_MS ?? 15 * 60_000),
    stallThresholdMs: Number(env.ROBOT_STALL_THRESHOLD_MS ?? 2 * 60 * 60_000),
    prPollIntervalMs: Number(env.ROBOT_PR_POLL_INTERVAL_MS ?? 3 * 60_000),
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
    auditIntervalMs: Number(env.AGENT_WORKER_AUDIT_INTERVAL_MS ?? 30_000),
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? '',
    robot: loadRobotConfig(env),
  };
}

export function dbPathFor(config: AgentWorkerConfig): string {
  return path.join(config.dataDir, 'dashboard.db');
}
