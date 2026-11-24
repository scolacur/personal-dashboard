import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
 * The commit the RUNNING IMAGE was built from (PD-528) — baked in at `docker build` time via
 * `--build-arg BUILD_SHA=...` (deploy.yml on GHCR; `robot-rebuild` on the emergency local path).
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

/** The image's build inputs (PD-816), from the grounding checkout's `ops/agent-worker/build-inputs.txt`. */
export function parseBuildInputs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Is the running image current even though `main` has moved past its BUILD_SHA? (PD-816, D-116)
 *
 * The worker image is published only when one of its build inputs changes, so after a web-only
 * merge BUILD_SHA trails `main` and the worker is still up to date. True when nothing in
 * `build-inputs.txt` differs between BUILD_SHA and the checkout's HEAD. False when something does,
 * which means the worker really is behind. Null when we cannot tell (no build sha, no checkout,
 * a sha the checkout doesn't have yet). The UI then falls back to comparing the shas, and never
 * reports "current" without evidence.
 */
export function buildIsCurrent(checkoutDir: string, build: string | null): boolean | null {
  if (!build) return null;
  try {
    const inputs = parseBuildInputs(readFileSync(path.join(checkoutDir, 'ops/agent-worker/build-inputs.txt'), 'utf8'));
    if (inputs.length === 0) return null;
    execFileSync('git', ['-C', checkoutDir, 'diff', '--quiet', build, 'HEAD', '--', ...inputs], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true; // exit 0: no build input changed
  } catch (err) {
    // `git diff --quiet` exits 1 when there ARE differences; anything else is "cannot tell".
    return (err as { status?: number }).status === 1 ? false : null;
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
      model       TEXT,
      build_current INTEGER
    );
  `);
  // PD-816: an existing table predates build_current. The server migrates it too; adding it here
  // as well lets either side deploy first (ALTER ADD COLUMN is additive and idempotent behind this
  // check).
  const cols = db.prepare('PRAGMA table_info(worker_heartbeat)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'build_current')) {
    db.exec('ALTER TABLE worker_heartbeat ADD COLUMN build_current INTEGER');
  }

  const startedAt = Date.now();
  const upsert = db.prepare(
    `INSERT INTO worker_heartbeat (worker, started_at, last_seen, pid, sha, build_sha, model, build_current)
     VALUES (@worker, @startedAt, @lastSeen, @pid, @sha, @buildSha, @model, @buildCurrent)
     ON CONFLICT(worker) DO UPDATE SET
       started_at = excluded.started_at,
       last_seen  = excluded.last_seen,
       pid        = excluded.pid,
       sha        = excluded.sha,
       build_sha  = excluded.build_sha,
       model      = excluded.model,
       build_current = excluded.build_current`,
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
        buildCurrent: ((c) => (c === null ? null : c ? 1 : 0))(buildIsCurrent(config.checkoutDir, buildSha())),
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
