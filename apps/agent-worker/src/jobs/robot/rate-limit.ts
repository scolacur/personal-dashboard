import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { GithubRateLimitStatus, RateLimitBucket } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { writeState } from './state';

const run = promisify(execFile);

/**
 * GitHub rate-limit headroom (PD-248) — a periodic probe, not response headers.
 *
 * **Why a probe.** Every GitHub call the loop makes goes through the `gh` CLI (`gh pr view` for the
 * PR-state poll, `git push` / `gh pr create` for the hand-off). `gh pr view` surfaces no
 * `x-ratelimit-*` headers at all, so there is literally nothing to thread through the existing call
 * sites — reading headers would mean rewriting every one of them against `gh api --include` and
 * parsing raw HTTP. One cheap call to `gh api rate_limit` answers the same question, and
 * `/rate_limit` is documented as **not itself counting against the limit**.
 *
 * This is the *visibility* half of PD-248. The *safety* half lives in `faults.ts`: a throttle that
 * actually lands is classified as a wait rather than an auth fault, so it holds dispatch instead of
 * pausing the loop. Neither depends on the other — the probe going dark degrades the dashboard, it
 * does not endanger the loop.
 */

/** `robot_state` key holding the last probe. Worker-written, server-read. */
export const RATE_LIMIT_STATE_KEY = 'github_rate_limit';

/** How often to probe. Comfortably inside `RATE_LIMIT_STALE_MS` so an ordinary reading never ages
 *  into "stale", which is reserved for the probe genuinely failing. */
export const RATE_LIMIT_PROBE_INTERVAL_MS = 5 * 60_000;

/** The subset of `gh api rate_limit` we read. GitHub reports `reset` in epoch SECONDS. */
interface RawBucket {
  remaining?: unknown;
  limit?: unknown;
  reset?: unknown;
}

function bucket(raw: RawBucket | undefined): RateLimitBucket | null {
  if (!raw) return null;
  const { remaining, limit, reset } = raw;
  if (typeof remaining !== 'number' || typeof limit !== 'number' || typeof reset !== 'number') return null;
  return { remaining, limit, resetAt: reset * 1000 };
}

/**
 * Parse `gh api rate_limit` output. Returns null on anything unrecognised.
 *
 * Defensive on purpose: this is a dashboard reading, and a shape change from GitHub must degrade to
 * "no data" rather than throwing inside the worker's interval. `core` is required — a payload
 * without it is not a rate-limit response — while `graphql` is optional, since only some tokens
 * report it.
 */
export function parseRateLimitProbe(stdout: string, checkedAt: number): GithubRateLimitStatus | null {
  let parsed: { resources?: Record<string, RawBucket>; rate?: RawBucket };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return null;
  }
  // `resources.core` is the documented location; `rate` is the legacy top-level mirror of it.
  const core = bucket(parsed.resources?.core) ?? bucket(parsed.rate);
  if (!core) return null;
  return { core, graphql: bucket(parsed.resources?.graphql), checkedAt };
}

/** Runs `gh api rate_limit`. Injectable so tests never shell out. */
export type RateLimitProbe = () => Promise<string>;

export function defaultRateLimitProbe(config: AgentWorkerConfig): RateLimitProbe {
  return async () => {
    const token = config.githubReadToken;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
      ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
    };
    const { stdout } = await run('gh', ['api', 'rate_limit'], { env });
    return stdout;
  };
}

/**
 * Probe once and record the result. Never throws.
 *
 * A failed probe deliberately leaves the PREVIOUS reading in place rather than clearing it: the
 * stored `checkedAt` then ages past `RATE_LIMIT_STALE_MS` and the dashboard reports "stale" on its
 * own. Writing a null would look identical to "never probed", which is a different thing.
 */
export async function recordRateLimit(
  db: Database.Database,
  probe: RateLimitProbe,
  now: number = Date.now(),
): Promise<GithubRateLimitStatus | null> {
  let stdout: string;
  try {
    stdout = await probe();
  } catch (err) {
    logger.warn({ err }, 'robot: GitHub rate-limit probe failed — last reading will age into stale');
    return null;
  }
  const status = parseRateLimitProbe(stdout, now);
  if (!status) {
    logger.warn('robot: GitHub rate-limit probe returned an unrecognised payload');
    return null;
  }
  writeState(db, RATE_LIMIT_STATE_KEY, JSON.stringify(status), now);
  return status;
}

/** Start the periodic probe. Fires once immediately so the dashboard has a reading before the first
 *  interval elapses, then on `RATE_LIMIT_PROBE_INTERVAL_MS`. */
export function startRateLimitProbe(
  db: Database.Database,
  config: AgentWorkerConfig,
  probe: RateLimitProbe = defaultRateLimitProbe(config),
): NodeJS.Timeout {
  void recordRateLimit(db, probe);
  const timer = setInterval(() => {
    void recordRateLimit(db, probe);
  }, RATE_LIMIT_PROBE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
