import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {
  WORKER_CONFIG_BOOT_KEY,
  WORKER_SETTINGS,
  WORKER_SETTING_GROUPS,
  resolveWorkerSetting,
  validateWorkerSettingValue,
  type WorkerConfigEntry,
} from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { autoQueueLimits } from './auto-queue';
import { getWorkerConfig, setConfigOverride } from './worker-config';

// PD-1006 (D-121): the worker tunables registry, the override store and its routes. The registry
// lives in packages/shared, which has no test runner, so its pure helpers are tested here too.

const base = '/api/widgets/task-monitor';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  return { db, app };
}

function publishBoot(db: Database.Database, values: Record<string, { value: number; source: 'env' | 'default'; applied: number }>) {
  db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, 1)').run(
    WORKER_CONFIG_BOOT_KEY,
    JSON.stringify({ publishedAt: 1000, values }),
  );
}

const def = (key: string) => WORKER_SETTINGS.find((d) => d.key === key)!;

describe('registry (PD-1006)', () => {
  it('covers every setting in the ticket’s In list', () => {
    const keys = new Set(WORKER_SETTINGS.map((d) => d.key));
    for (const k of [
      'ROBOT_BUDGET_TURNS', 'ROBOT_BUDGET_TOKENS', 'ROBOT_BUDGET_WINDOW_MS',
      'EVALUATOR_BUDGET_TURNS', 'EVALUATOR_BUDGET_TOKENS', 'EVALUATOR_BUDGET_WINDOW_MS',
      'ROBOT_INTERVAL_MS', 'ROBOT_PR_POLL_INTERVAL_MS', 'EVALUATOR_INTERVAL_MS', 'AGENT_WORKER_REFINE_INTERVAL_MS',
      'AGENT_WORKER_AUDIT_INTERVAL_MS', 'CONFLICT_RESOLVER_INTERVAL_MS', 'VISUAL_CAPTURE_INTERVAL_MS', 'SZZ_INTERVAL_MS',
      'AGENT_WORKER_PULL_INTERVAL_MS', 'MAINTENANCE_HOLD_POLL_MS',
      'REFINE_OPEN_CAP', 'AGENT_WORKER_REFINE_MAX_TURNS', 'EVALUATOR_MAX_ROUNDS', 'EVALUATOR_ADOPT_IDLE_MS', 'ROBOT_MAX_TURNS',
      'CHECKPOINT_WINDOW_TURNS', 'CHECKPOINT_FIRST_WINDOW_TURNS', 'CHECKPOINT_TOTAL_TURNS', 'CHECKPOINT_REPEAT_LIMIT',
      'ROBOT_RETRY_CAP', 'ROBOT_ORPHAN_CAP', 'ROBOT_BREAKER_FAILURES', 'ROBOT_RESTART_BREAKER_COUNT',
      'ROBOT_RESTART_BREAKER_WINDOW_MS', 'ROBOT_PROMOTE_AFTER', 'ROBOT_STALL_THRESHOLD_MS', 'ROBOT_SUPERSEDE_CHECK_MS',
      'ROBOT_BACKOFF_BASE_MS', 'ROBOT_BACKOFF_MAX_MS',
      'AUTO_QUEUE_QUEUE_DEPTH_FACTOR', 'AUTO_QUEUE_REVIEW_WIP_LIMIT', 'AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT',
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  // The Out list: never secrets, tokens, paths, the repo, bot identity, proxy, URLs, models, or the
  // PD-511 toggles. Budget *tokens* (a spend unit) are the one legitimate "TOKEN" in a name.
  it('holds no secret, token, path, repo, identity, proxy, URL, model or PD-511 setting', () => {
    const forbidden = /(_TOKEN$|SECRET|API_KEY|PASSWORD|_PATH$|_DIR$|_HOME$|_URL|REPO|PROXY|MODEL|BOT_NAME|BOT_EMAIL|_UID$|_GID$|_ENABLED$|ALLOWLIST|CONCURRENCY)/;
    for (const d of WORKER_SETTINGS) expect(d.key, d.key).not.toMatch(forbidden);
  });

  it('every group is a page section, and every setting is a whole-number unit', () => {
    const groups = new Set(WORKER_SETTING_GROUPS.map((g) => g.id));
    for (const d of WORKER_SETTINGS) {
      expect(groups.has(d.group), d.key).toBe(true);
      expect(['count', 'ms', 'turns', 'tokens']).toContain(d.unit);
    }
  });

  it('interval settings that arm a boot-time timer are restart-only; budgets and caps are live', () => {
    for (const k of ['ROBOT_INTERVAL_MS', 'EVALUATOR_INTERVAL_MS', 'SZZ_INTERVAL_MS', 'AGENT_WORKER_PULL_INTERVAL_MS']) {
      expect(def(k).live, k).toBe(false);
    }
    for (const k of ['ROBOT_BUDGET_TURNS', 'EVALUATOR_BUDGET_TURNS', 'EVALUATOR_MAX_ROUNDS', 'ROBOT_RETRY_CAP', 'REFINE_OPEN_CAP']) {
      expect(def(k).live, k).toBe(true);
    }
  });
});

describe('validation bounds', () => {
  const d = def('EVALUATOR_BUDGET_TURNS');
  it('accepts an in-bounds integer, as a number or numeric string', () => {
    expect(validateWorkerSettingValue(d, 1500)).toEqual({ ok: true, value: 1500 });
    expect(validateWorkerSettingValue(d, '800')).toEqual({ ok: true, value: 800 });
    expect(validateWorkerSettingValue(d, d.min)).toEqual({ ok: true, value: d.min });
    expect(validateWorkerSettingValue(d, d.max)).toEqual({ ok: true, value: d.max });
  });
  it('refuses non-numeric, fractional and out-of-bounds values with a reason naming the setting', () => {
    for (const bad of ['abc', '', null, undefined, true, {}, NaN, Infinity]) {
      const r = validateWorkerSettingValue(d, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/EVALUATOR_BUDGET_TURNS must be a number/);
    }
    const frac = validateWorkerSettingValue(d, 1.5);
    expect(frac.ok === false && frac.reason).toMatch(/whole number/);
    const high = validateWorkerSettingValue(d, d.max + 1);
    expect(high.ok === false && high.reason).toMatch(/between 0 and 20000/);
    expect(validateWorkerSettingValue(d, -1).ok).toBe(false);
  });
});

describe('precedence: override ?? env ?? default (D-121)', () => {
  const d = def('ROBOT_BUDGET_TURNS');
  it('resolves in order and names the source', () => {
    expect(resolveWorkerSetting(d, null, null)).toEqual({ value: 500, source: 'default' });
    expect(resolveWorkerSetting(d, { value: 900, source: 'env' }, null)).toEqual({ value: 900, source: 'env' });
    expect(resolveWorkerSetting(d, { value: 900, source: 'env' }, 50)).toEqual({ value: 50, source: 'override' });
  });

  it('server-read AUTO_QUEUE limits take a DB override on the next read', () => {
    const { db } = setup();
    expect(autoQueueLimits(db).reviewWip).toBe(3);
    setConfigOverride(db, 'AUTO_QUEUE_REVIEW_WIP_LIMIT', '7');
    expect(autoQueueLimits(db).reviewWip).toBe(7);
    expect(autoQueueLimits().reviewWip).toBe(3); // no db ⇒ env/default only
  });

  it('the server reports its own env as the boot value for server-read settings', () => {
    const { db } = setup();
    const e = getWorkerConfig(db, { AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT: '2' }).entries.find((x) => x.key === 'AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT')!;
    expect(e).toMatchObject({ boot: 2, bootSource: 'env', effective: 2, source: 'env' });
  });
});

describe('GET/PUT/DELETE /worker-config', () => {
  it('lists every registry setting with boot, override, effective and live', async () => {
    const { app, db } = setup();
    publishBoot(db, { EVALUATOR_BUDGET_TURNS: { value: 1500, source: 'env', applied: 1500 } });
    const body = (await app.inject({ method: 'GET', url: `${base}/worker-config` })).json();
    expect(body.entries.map((e: WorkerConfigEntry) => e.key)).toEqual(WORKER_SETTINGS.map((d) => d.key));
    expect(body.workerBootAt).toBe(1000);
    const ev = body.entries.find((e: WorkerConfigEntry) => e.key === 'EVALUATOR_BUDGET_TURNS');
    expect(ev).toMatchObject({ boot: 1500, bootSource: 'env', override: null, effective: 1500, source: 'env', live: true });
    // Not yet reported by the worker ⇒ no boot value, effective falls back to the code default.
    const unreported = body.entries.find((e: WorkerConfigEntry) => e.key === 'ROBOT_RETRY_CAP');
    expect(unreported).toMatchObject({ boot: null, bootSource: null, effective: 3, source: 'default' });
  });

  it('PUT sets an override and DELETE (Reset) falls back to env', async () => {
    const { app, db } = setup();
    publishBoot(db, { EVALUATOR_BUDGET_TURNS: { value: 1500, source: 'env', applied: 1500 } });
    const put = await app.inject({ method: 'PUT', url: `${base}/worker-config/EVALUATOR_BUDGET_TURNS`, payload: { value: 800 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ override: 800, effective: 800, source: 'override', boot: 1500 });
    const row = db.prepare("SELECT value FROM config_overrides WHERE key = 'EVALUATOR_BUDGET_TURNS'").get() as { value: string };
    expect(row.value).toBe('800');

    const del = await app.inject({ method: 'DELETE', url: `${base}/worker-config/EVALUATOR_BUDGET_TURNS` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ override: null, effective: 1500, source: 'env' });
  });

  it('refuses an out-of-bounds or non-numeric value with a 400 and a clear reason', async () => {
    const { app, db } = setup();
    const high = await app.inject({ method: 'PUT', url: `${base}/worker-config/ROBOT_RETRY_CAP`, payload: { value: 999 } });
    expect(high.statusCode).toBe(400);
    expect(high.json()).toEqual({ error: 'ROBOT_RETRY_CAP must be between 0 and 20 (got 999).', code: 'INVALID_VALUE' });
    const nan = await app.inject({ method: 'PUT', url: `${base}/worker-config/ROBOT_RETRY_CAP`, payload: { value: 'ten' } });
    expect(nan.statusCode).toBe(400);
    expect(nan.json().error).toBe('ROBOT_RETRY_CAP must be a number.');
    const missing = await app.inject({ method: 'PUT', url: `${base}/worker-config/ROBOT_RETRY_CAP`, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM config_overrides').get()).toEqual({ n: 0 });
  });

  it('404s a key outside the registry — a secret cannot be stored or read through it', async () => {
    const { app, db } = setup();
    for (const method of ['PUT', 'DELETE'] as const) {
      const r = await app.inject({ method, url: `${base}/worker-config/ROBOT_GITHUB_TOKEN`, payload: { value: 1 } });
      expect(r.statusCode).toBe(404);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM config_overrides').get()).toEqual({ n: 0 });
  });

  it('the response carries only registry fields — no secret, token value or path', async () => {
    const { app, db } = setup();
    // A stray row for a non-registry key (written by hand) must not leak into the response.
    setConfigOverride(db, 'ROBOT_GITHUB_TOKEN', 'ghp_secret');
    const res = await app.inject({ method: 'GET', url: `${base}/worker-config` });
    const text = res.body;
    expect(text).not.toContain('ghp_secret');
    expect(text).not.toContain('ROBOT_GITHUB_TOKEN');
    expect(text).not.toMatch(/\/data\/|\/home\/|https?:\/\//);
    const allowed = new Set([
      'key', 'label', 'group', 'unit', 'description', 'min', 'max', 'live', 'readBy', 'default',
      'boot', 'bootSource', 'override', 'overrideUpdatedAt', 'effective', 'source', 'pendingRestart',
    ]);
    for (const e of res.json().entries) for (const k of Object.keys(e)) expect(allowed.has(k), k).toBe(true);
  });

  it('flags a restart-only override the running worker has not picked up yet', async () => {
    const { app, db } = setup();
    publishBoot(db, { SZZ_INTERVAL_MS: { value: 3_600_000, source: 'default', applied: 3_600_000 } });
    const put = await app.inject({ method: 'PUT', url: `${base}/worker-config/SZZ_INTERVAL_MS`, payload: { value: 7_200_000 } });
    expect(put.json()).toMatchObject({ live: false, effective: 7_200_000, pendingRestart: true });
    // After a restart the worker reports it applied the override.
    publishBoot(db, { SZZ_INTERVAL_MS: { value: 3_600_000, source: 'default', applied: 7_200_000 } });
    const e = getWorkerConfig(db).entries.find((x) => x.key === 'SZZ_INTERVAL_MS')!;
    expect(e.pendingRestart).toBe(false);
  });
});
