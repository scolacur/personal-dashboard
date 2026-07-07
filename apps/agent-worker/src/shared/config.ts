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
  /** Squid proxy URL when egress-hardened; empty in local dev (direct egress). */
  httpsProxy: string;
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
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? '',
  };
}

export function dbPathFor(config: AgentWorkerConfig): string {
  return path.join(config.dataDir, 'dashboard.db');
}
