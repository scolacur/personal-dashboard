import type Database from 'better-sqlite3';
import { WORKER_CONFIG_BOOT_KEY, WORKER_SETTINGS, type WorkerConfigBootSnapshot } from '@dashboard/shared';
import { setConfigOverride } from '../widgets/task-monitor/worker-config';

/**
 * /devops/configure fixture (PD-1006): a published worker boot snapshot (with one env-set value, as
 * on the NAS) plus a live override and a restart-only override, so the capture shows every row state
 * — env vs default, overridden, and "not in force until the worker restarts".
 */

export function workerConfigIsEmpty(db: Database.Database): boolean {
  const overrides = db.prepare('SELECT COUNT(*) AS n FROM config_overrides').get() as { n: number };
  if (overrides.n > 0) return false;
  try {
    return !db.prepare('SELECT 1 FROM robot_state WHERE key = ?').get(WORKER_CONFIG_BOOT_KEY);
  } catch {
    return true; // no robot_state table yet
  }
}

export function seedWorkerConfig(db: Database.Database, now: number): void {
  const env: Record<string, number> = { EVALUATOR_BUDGET_TURNS: 1500, ROBOT_BUDGET_TURNS: 600 };
  const values: WorkerConfigBootSnapshot['values'] = {};
  for (const d of WORKER_SETTINGS) {
    if (d.readBy !== 'worker') continue;
    const value = env[d.key] ?? d.default;
    values[d.key] = { value, source: d.key in env ? 'env' : 'default', applied: value };
  }
  db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    WORKER_CONFIG_BOOT_KEY,
    JSON.stringify({ publishedAt: now - 60 * 60_000, values } satisfies WorkerConfigBootSnapshot),
    now,
  );
  setConfigOverride(db, 'EVALUATOR_BUDGET_TURNS', '2000', now);
  setConfigOverride(db, 'SZZ_INTERVAL_MS', String(2 * 60 * 60_000), now);
}
