import path from 'node:path';

/**
 * Griller worker configuration (D-044). All env-driven so the same image runs in
 * the egress-hardened container and locally in dev. Secrets (ANTHROPIC_API_KEY,
 * GITHUB_READ_TOKEN) live in the griller's OWN env file — never the web process.
 */
export interface GrillerConfig {
  /** Opus by default — the griller plans well and asks the right questions (D-044). */
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
  /** Squid proxy URL when egress-hardened; empty in local dev (direct egress). */
  httpsProxy: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GrillerConfig {
  return {
    model: env.GRILLER_MODEL ?? 'claude-opus-4-8',
    githubRepo: env.GRILLER_GITHUB_REPO ?? 'scolacur/personal-dashboard',
    githubReadToken: env.GITHUB_READ_TOKEN ?? '',
    checkoutDir: env.GRILLER_CHECKOUT_DIR ?? '/data/griller-checkout',
    dataDir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    pullIntervalMs: Number(env.GRILLER_PULL_INTERVAL_MS ?? 5 * 60_000),
    httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? '',
  };
}

export function dbPathFor(config: GrillerConfig): string {
  return path.join(config.dataDir, 'dashboard.db');
}
