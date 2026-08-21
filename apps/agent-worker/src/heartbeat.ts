import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from './shared/config';
import { logger } from './shared/logger';

/**
 * Worker liveness beacon (Site Status, PD Tier-2). This process shares the dashboard DB
 * with the web server but never talks to it directly — instead it upserts a single
 * `worker_heartbeat` row on an interval, and the board reads it to show "agent-worker:
 * alive · last seen Ns ago · sha …". A stale `last_seen` (older than a small multiple of
 * the interval) is how the UI infers the worker is down.
 */

const WORKER_NAME = 'agent-worker';
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The commit the RUNNING IMAGE was built from (PD-528) — baked in at `docker build` time by
 * `robot-refresh` via `--build-arg BUILD_SHA=...`.
 *
 * This is the worker's actual version, and it is the one a human needs: the checkout sha below
 * tracks `main` continuously, so it looks current even when the process has been running week-old
 * code. Null on an image built before the build-arg existed — reported as unknown, never silently
 * substituted with the checkout sha.
 */
function buildSha(): string | null {
  const v = process.env.AGENT_WORKER_BUILD_SHA;
  return v && v.trim() ? v.trim() : null;
}

/** Short HEAD sha of the GROUNDING CHECKOUT — the code the agent reads, not the code we run. */
function currentSha(config: AgentWorkerConfig): string | null {
  try {
    const out = execFileSync('git', ['-C', config.checkoutDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function startHeartbeat(db: Database.Database, config: AgentWorkerConfig): void {
  // The web server owns this table's schema, but the worker can boot first against a
  // fresh shared volume. Defensive CREATE — keep this DDL in sync with schema.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_heartbeat (
      worker      TEXT    PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      pid         INTEGER,
      sha         TEXT,
      build_sha   TEXT,
      model       TEXT
    );
  `);

  const startedAt = Date.now();
  const upsert = db.prepare(
    `INSERT INTO worker_heartbeat (worker, started_at, last_seen, pid, sha, build_sha, model)
     VALUES (@worker, @startedAt, @lastSeen, @pid, @sha, @buildSha, @model)
     ON CONFLICT(worker) DO UPDATE SET
       started_at = excluded.started_at,
       last_seen  = excluded.last_seen,
       pid        = excluded.pid,
       sha        = excluded.sha,
       build_sha  = excluded.build_sha,
       model      = excluded.model`,
  );

  const beat = (): void => {
    try {
      upsert.run({
        worker: WORKER_NAME,
        startedAt,
        lastSeen: Date.now(),
        pid: process.pid,
        sha: currentSha(config),
        buildSha: buildSha(),
        model: config.model,
      });
    } catch (err) {
      logger.warn({ err }, 'heartbeat write failed');
    }
  };

  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref(); // don't keep the process alive on the heartbeat alone
  logger.info({ intervalMs: HEARTBEAT_INTERVAL_MS }, 'heartbeat started');
}
