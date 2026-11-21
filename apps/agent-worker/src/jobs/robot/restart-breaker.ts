import type Database from 'better-sqlite3';
import { logger } from '../../shared/logger';
import { notifyLoop } from './notify';
import { pauseDispatch, writeState } from './state';

/**
 * The restart breaker (PD-784, D-104): the worker-wide counterpart to the per-ticket orphan cap.
 *
 * Once the graceful stop works, a routine deploy closes its runs as `interrupted` and leaves no
 * orphan. So a boot that finds orphaned `running` rows means the previous incarnation died
 * UNCLEANLY (OOM kill, crash, host reboot, SIGKILL after the stop-grace window). One of those is
 * noise. Several in a short window means something is killing the worker — and if it isn't tied to
 * one ticket (which the orphan cap would park), re-dispatching just feeds a crash loop that
 * `restart: unless-stopped` keeps restarting.
 *
 * Every worker incarnation whose stall sweep reclaims at least one orphan records ONE unclean
 * restart, keyed by that incarnation's `processStartedAt` so repeated cycles of the same process
 * never double-count. With `ROBOT_CONCURRENCY > 1` one death orphans several runs at once; it is
 * still one restart. When `count` restarts land within `windowMs`, dispatch pauses through the
 * same durable pause a system-wide fault uses (D-072, and the circuit breaker D-103 gives the
 * worker). Resuming is a human act, as it is for every pause.
 *
 * The record is durable (`robot_state`) on purpose — the whole point is to remember across the very
 * restarts it counts.
 */

const KEY = 'unclean_restarts';

export interface RestartBreakerPolicy {
  count: number;
  windowMs: number;
}

/** The recorded unclean-restart timestamps (each an incarnation's `processStartedAt`). */
export function uncleanRestarts(db: Database.Database): number[] {
  const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(KEY) as { value: string | null } | undefined;
  if (!row?.value) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return []; // a corrupt record must not wedge the loop; it just restarts the count
  }
}

/**
 * Record that the incarnation started at `processStartedAt` found orphans (it is the survivor of an
 * unclean restart), and trip the breaker if the window now holds `policy.count` of them. Idempotent
 * per incarnation. Returns true when this call paused dispatch.
 */
export function recordUncleanRestart(
  db: Database.Database,
  processStartedAt: number,
  policy: RestartBreakerPolicy,
  now: number = Date.now(),
): boolean {
  const prior = uncleanRestarts(db);
  if (prior.includes(processStartedAt)) return false; // this incarnation already counted

  const recent = [...prior, processStartedAt].filter((t) => now - t <= policy.windowMs);
  writeState(db, KEY, JSON.stringify(recent), now);
  logger.warn({ recent: recent.length, threshold: policy.count }, 'robot: unclean worker restart recorded (orphaned runs found)');

  if (recent.length < policy.count) return false;

  const hours = Math.round((policy.windowMs / 3_600_000) * 10) / 10;
  const reason = `restart breaker: the worker died uncleanly ${recent.length}× in ${hours}h, leaving runs orphaned — dispatch paused until a human resumes it`;
  pauseDispatch(db, reason, now);
  notifyLoop(db, 'agent_needs_human', 'Robot paused: repeated worker crashes', reason, now);
  logger.error({ recent: recent.length, windowMs: policy.windowMs }, 'robot: restart breaker TRIPPED — PAUSING dispatch');
  return true;
}
