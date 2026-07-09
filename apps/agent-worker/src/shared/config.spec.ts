import { describe, it, expect } from 'vitest';
import { loadConfig, dbPathFor, loadRobotConfig } from './config';

describe('loadConfig', () => {
  it('applies sensible defaults (Opus, PD repo, /data checkout)', () => {
    const c = loadConfig({});
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.githubRepo).toBe('scolacur/personal-dashboard');
    expect(c.checkoutDir).toBe('/data/agent-worker-checkout');
    expect(c.githubReadToken).toBe('');
    expect(c.httpsProxy).toBe('');
    expect(c.pullIntervalMs).toBe(5 * 60_000);
    expect(c.refineIntervalMs).toBe(5_000);
    expect(c.auditIntervalMs).toBe(30_000);
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      AGENT_WORKER_MODEL: 'claude-sonnet-4-6',
      AGENT_WORKER_GITHUB_REPO: 'me/other',
      GITHUB_READ_TOKEN: 'tok',
      AGENT_WORKER_CHECKOUT_DIR: '/co',
      DATA_DIR: '/d',
      AGENT_WORKER_PULL_INTERVAL_MS: '1000',
      AGENT_WORKER_AUDIT_INTERVAL_MS: '2000',
      HTTPS_PROXY: 'http://egress-proxy:3128',
    });
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.githubRepo).toBe('me/other');
    expect(c.githubReadToken).toBe('tok');
    expect(c.checkoutDir).toBe('/co');
    expect(c.pullIntervalMs).toBe(1000);
    expect(c.auditIntervalMs).toBe(2000);
    expect(c.httpsProxy).toBe('http://egress-proxy:3128');
    expect(dbPathFor(c)).toBe('/d/dashboard.db');
  });

  it('falls back to lowercase https_proxy', () => {
    expect(loadConfig({ https_proxy: 'http://p:3128' }).httpsProxy).toBe('http://p:3128');
  });

  it('nests the robot config, off by default', () => {
    expect(loadConfig({}).robot.dispatchEnabled).toBe(false);
  });
});

describe('loadRobotConfig', () => {
  it('is inert by default (disabled, empty allowlist, concurrency 1)', () => {
    const s = loadRobotConfig({});
    expect(s.dispatchEnabled).toBe(false);
    expect(s.allowlist).toEqual([]);
    expect(s.concurrency).toBe(1);
    expect(s.intervalMs).toBe(15_000);
    expect(s.worktreesDir).toBe('/data/robot-worktrees');
    expect(s.writeToken).toBe('');
    expect(s.maxTurns).toBe(50);
    expect(s.codingUid).toBeUndefined();
    expect(s.codingGid).toBeUndefined();
    expect(s.codingHome).toBe('/home/robot');
  });

  it('reads a custom coding home', () => {
    expect(loadRobotConfig({ ROBOT_CODING_HOME: '/home/coder' }).codingHome).toBe('/home/coder');
  });

  it('enables on "1" or "true"', () => {
    expect(loadRobotConfig({ ROBOT_DISPATCH_ENABLED: '1' }).dispatchEnabled).toBe(true);
    expect(loadRobotConfig({ ROBOT_DISPATCH_ENABLED: 'true' }).dispatchEnabled).toBe(true);
    expect(loadRobotConfig({ ROBOT_DISPATCH_ENABLED: 'yes' }).dispatchEnabled).toBe(false);
  });

  it('parses a comma-separated allowlist, dropping blanks/non-integers', () => {
    expect(loadRobotConfig({ ROBOT_ALLOWLIST: '429, 431 ,x,' }).allowlist).toEqual([429, 431]);
    expect(loadRobotConfig({ ROBOT_ALLOWLIST: '' }).allowlist).toEqual([]);
  });

  it('reads uid/gid only when set to a valid integer', () => {
    const s = loadRobotConfig({ ROBOT_CODING_UID: '1500', ROBOT_CODING_GID: '1500' });
    expect(s.codingUid).toBe(1500);
    expect(s.codingGid).toBe(1500);
    expect(loadRobotConfig({ ROBOT_CODING_UID: '' }).codingUid).toBeUndefined();
    expect(loadRobotConfig({ ROBOT_CODING_UID: 'root' }).codingUid).toBeUndefined();
  });

  it('reads the write token + bot identity + knobs from env', () => {
    const s = loadRobotConfig({
      ROBOT_GITHUB_TOKEN: 'ghp_x',
      ROBOT_BOT_NAME: 'bot',
      ROBOT_BOT_EMAIL: 'bot@example.com',
      ROBOT_CONCURRENCY: '2',
      ROBOT_INTERVAL_MS: '9000',
      ROBOT_WORKTREES_DIR: '/wt',
      ROBOT_MAX_TURNS: '30',
    });
    expect(s.writeToken).toBe('ghp_x');
    expect(s.botName).toBe('bot');
    expect(s.botEmail).toBe('bot@example.com');
    expect(s.concurrency).toBe(2);
    expect(s.intervalMs).toBe(9000);
    expect(s.worktreesDir).toBe('/wt');
    expect(s.maxTurns).toBe(30);
  });
});
