import type Database from 'better-sqlite3';
import {
  CONFIG_OVERRIDES_TABLE,
  WORKER_CONFIG_BOOT_KEY,
  WORKER_SETTINGS,
  resolveWorkerSetting,
  validateWorkerSettingValue,
  workerSettingDef,
  type WorkerConfigBootSnapshot,
  type WorkerConfigEntry,
  type WorkerConfigResponse,
  type WorkerSettingDef,
} from '@dashboard/shared';

// The override store behind /devops/configure (PD-1006, D-121).
//
// `config_overrides` holds one row per overridden tunable; the env var stays the boot default. The
// worker re-reads live rows every pass (`effectiveConfig` in apps/agent-worker); the server reads its
// own (the AUTO_QUEUE_* limits) through `serverSetting`. PD-511 (Runtime toggles: enable/disable each
// agent type + Robot concurrency, without a recreate) writes its rows through the same helpers.

export interface ConfigOverrideRow {
  value: string;
  updatedAt: number;
}

/** Every override row, by key. Empty when the table does not exist yet. */
export function listConfigOverrides(db: Database.Database): Map<string, ConfigOverrideRow> {
  try {
    const rows = db.prepare(`SELECT key, value, updated_at FROM ${CONFIG_OVERRIDES_TABLE}`).all() as {
      key: string;
      value: string;
      updated_at: number;
    }[];
    return new Map(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updated_at }]));
  } catch {
    return new Map();
  }
}

export function setConfigOverride(db: Database.Database, key: string, value: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO ${CONFIG_OVERRIDES_TABLE} (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/** Returns whether a row was removed. */
export function clearConfigOverride(db: Database.Database, key: string): boolean {
  return db.prepare(`DELETE FROM ${CONFIG_OVERRIDES_TABLE} WHERE key = ?`).run(key).changes > 0;
}

/** A non-negative integer env var, or undefined for anything missing or malformed (PD-811's rule). */
function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** A valid override for `def`, or null (none set, or a row the bounds now reject). */
function validOverride(def: WorkerSettingDef, row: ConfigOverrideRow | undefined): number | null {
  if (!row) return null;
  const v = validateWorkerSettingValue(def, row.value);
  return v.ok ? v.value : null;
}

/**
 * A server-read tunable's effective value: override ?? env ?? `fallback` (D-121). Read on every use,
 * so an override applies on the next computation with no restart.
 */
export function serverSetting(
  db: Database.Database | undefined,
  key: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const def = workerSettingDef(key);
  if (db && def) {
    const o = validOverride(def, listConfigOverrides(db).get(key));
    if (o !== null) return o;
  }
  return envInt(env, key) ?? fallback;
}

/** The worker's published boot snapshot, or null before a worker with PD-1006 has booted. */
export function readWorkerConfigBoot(db: Database.Database): WorkerConfigBootSnapshot | null {
  try {
    const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(WORKER_CONFIG_BOOT_KEY) as
      | { value: string | null }
      | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as WorkerConfigBootSnapshot;
    return parsed && typeof parsed.values === 'object' && parsed.values !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every registry setting with its boot value, override and effective value — the body of
 * `GET /worker-config`. Built ONLY from registry fields and numbers, so nothing outside the registry
 * (no secret, token or path) can reach the response.
 */
export function getWorkerConfig(db: Database.Database, env: NodeJS.ProcessEnv = process.env): WorkerConfigResponse {
  const overrides = listConfigOverrides(db);
  const snapshot = readWorkerConfigBoot(db);
  const entries = WORKER_SETTINGS.map((def): WorkerConfigEntry => {
    let boot: { value: number; source: 'env' | 'default' } | null;
    let applied: number | null = null;
    if (def.readBy === 'server') {
      const fromEnv = envInt(env, def.key);
      boot = fromEnv !== undefined ? { value: fromEnv, source: 'env' } : { value: def.default, source: 'default' };
    } else {
      const s = snapshot?.values[def.key];
      boot = s && typeof s.value === 'number' ? { value: s.value, source: s.source === 'env' ? 'env' : 'default' } : null;
      applied = s && typeof s.applied === 'number' ? s.applied : null;
    }
    const row = overrides.get(def.key);
    const override = validOverride(def, row);
    const resolved = resolveWorkerSetting(def, boot, override);
    return {
      key: def.key,
      label: def.label,
      group: def.group,
      unit: def.unit,
      description: def.description,
      min: def.min,
      max: def.max,
      live: def.live,
      readBy: def.readBy,
      default: def.default,
      boot: boot?.value ?? null,
      bootSource: boot?.source ?? null,
      override,
      overrideUpdatedAt: override !== null && row ? row.updatedAt : null,
      effective: resolved.value,
      source: resolved.source,
      pendingRestart: !def.live && applied !== null && applied !== resolved.value,
    };
  });
  return { entries, workerBootAt: snapshot?.publishedAt ?? null };
}
