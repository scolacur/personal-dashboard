import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { WORKER_CONFIG_BOOT_KEY, WORKER_SETTINGS } from '@dashboard/shared';
import { loadConfig } from './config';
import {
  CONFIG_ACCESSORS,
  effectiveConfig,
  fullyEffectiveConfig,
  publishWorkerConfigBoot,
  readConfigOverrides,
  startupConfig,
  workerConfigBootSnapshot,
} from './effective-config';
import { MAX_EVALUATION_ROUNDS } from '../jobs/evaluate/verdict';

const WORKER = WORKER_SETTINGS.filter((d) => d.readBy === 'worker');

describe('worker tunables registry ↔ config.ts parity (PD-1006)', () => {
  it('every worker-read registry key has an accessor, and every accessor is in the registry', () => {
    expect(Object.keys(CONFIG_ACCESSORS).sort()).toEqual(WORKER.map((d) => d.key).sort());
  });

  it('keys are unique and every default sits inside its own bounds', () => {
    expect(new Set(WORKER_SETTINGS.map((d) => d.key)).size).toBe(WORKER_SETTINGS.length);
    for (const d of WORKER_SETTINGS) {
      expect(Number.isInteger(d.default), d.key).toBe(true);
      expect(d.min <= d.default && d.default <= d.max, d.key).toBe(true);
    }
  });

  it("the registry default is config.ts's default for every setting", () => {
    const c = loadConfig({});
    for (const d of WORKER) expect(CONFIG_ACCESSORS[d.key].get(c), d.key).toBe(d.default);
    expect(WORKER_SETTINGS.find((d) => d.key === 'EVALUATOR_MAX_ROUNDS')!.default).toBe(MAX_EVALUATION_ROUNDS);
  });

  it('config.ts really reads every registry env var into the field the accessor names', () => {
    for (const d of WORKER) {
      const v = d.min !== d.default ? d.min : d.max;
      const c = loadConfig({ [d.key]: String(v) });
      expect(CONFIG_ACCESSORS[d.key].get(c), d.key).toBe(v);
    }
  });
});

let db: Database.Database;
function setOverride(key: string, value: string): void {
  db.prepare(
    `INSERT INTO config_overrides (key, value, updated_at) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE config_overrides (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
});

describe('override precedence (D-121): override ?? env ?? default', () => {
  it('no table yet (worker booted before the server) ⇒ env values, no throw', () => {
    const bare = new Database(':memory:');
    const base = loadConfig({ EVALUATOR_BUDGET_TURNS: '1500' });
    expect(readConfigOverrides(bare).size).toBe(0);
    expect(effectiveConfig(bare, base)).toBe(base);
  });

  it('a live override beats env; without one, env beats the code default', () => {
    const base = loadConfig({ EVALUATOR_BUDGET_TURNS: '1500' });
    expect(effectiveConfig(db, base).evaluator.budgetTurns).toBe(1500);
    setOverride('EVALUATOR_BUDGET_TURNS', '800');
    expect(effectiveConfig(db, base).evaluator.budgetTurns).toBe(800);
    expect(effectiveConfig(db, loadConfig({})).robot.budgetTurns).toBe(500);
  });

  it('never mutates the base, so clearing an override falls straight back to env', () => {
    const base = loadConfig({ ROBOT_BUDGET_TURNS: '700' });
    setOverride('ROBOT_BUDGET_TURNS', '50');
    expect(effectiveConfig(db, base).robot.budgetTurns).toBe(50);
    expect(base.robot.budgetTurns).toBe(700);
    db.prepare('DELETE FROM config_overrides').run();
    expect(effectiveConfig(db, base).robot.budgetTurns).toBe(700);
  });

  it('a restart-only override is ignored per pass and taken by startupConfig', () => {
    const base = loadConfig({});
    setOverride('ROBOT_INTERVAL_MS', '30000');
    expect(effectiveConfig(db, base).robot.intervalMs).toBe(15_000);
    const started = startupConfig(db, base);
    expect(started.robot.intervalMs).toBe(30_000);
    // startupConfig leaves live settings to the per-pass read.
    setOverride('ROBOT_BUDGET_TURNS', '10');
    expect(startupConfig(db, base).robot.budgetTurns).toBe(500);
    expect(fullyEffectiveConfig(db, base).robot).toMatchObject({ intervalMs: 30_000, budgetTurns: 10 });
  });

  it('an invalid or out-of-bounds row is ignored, keeping the env value', () => {
    const base = loadConfig({ ROBOT_RETRY_CAP: '3' });
    setOverride('ROBOT_RETRY_CAP', 'lots');
    expect(effectiveConfig(db, base).robot.retryCap).toBe(3);
    setOverride('ROBOT_RETRY_CAP', '999');
    expect(effectiveConfig(db, base).robot.retryCap).toBe(3);
  });

  it('an unknown key (a setting not in the registry) is never applied', () => {
    const base = loadConfig({});
    setOverride('ROBOT_GITHUB_TOKEN', 'x');
    expect(effectiveConfig(db, base)).toEqual(base);
  });
});

describe('boot snapshot (PD-1006)', () => {
  it('records env vs default and what the worker started with', () => {
    const env = { EVALUATOR_BUDGET_TURNS: '1500' };
    const boot = loadConfig(env);
    setOverride('SZZ_INTERVAL_MS', String(2 * 60 * 60_000));
    const snap = workerConfigBootSnapshot(boot, startupConfig(db, boot), env, 42);
    expect(snap.publishedAt).toBe(42);
    expect(snap.values.EVALUATOR_BUDGET_TURNS).toEqual({ value: 1500, source: 'env', applied: 1500 });
    expect(snap.values.SZZ_INTERVAL_MS).toEqual({ value: 60 * 60_000, source: 'default', applied: 2 * 60 * 60_000 });
    expect(Object.keys(snap.values).sort()).toEqual(WORKER.map((d) => d.key).sort());
  });

  it('is published to robot_state under worker_config_boot', () => {
    const boot = loadConfig({});
    publishWorkerConfigBoot(db, boot, boot, {}, 7);
    const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(WORKER_CONFIG_BOOT_KEY) as { value: string };
    expect(JSON.parse(row.value).values.ROBOT_BUDGET_TURNS).toEqual({ value: 500, source: 'default', applied: 500 });
  });
});
