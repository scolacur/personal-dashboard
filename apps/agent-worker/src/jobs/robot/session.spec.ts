import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { codingEnv, readHandoff, runRobotSession, type RunQuery } from './session';
import { VERIFY_OK_MARKER, SCM_JSON, ASK_HUMAN_MARKER } from './prompt';
import type { RobotCandidate } from './select';
import type { Worktree } from './workspace';

const candidate: RobotCandidate = {
  id: 429,
  issueNumber: 220,
  repo: 'scolacur/personal-dashboard',
  title: 'T',
  body: 'b',
};

describe('codingEnv', () => {
  it('injects the WRITE token as GH_TOKEN and strips the read token', () => {
    const c = loadConfig({ ROBOT_GITHUB_TOKEN: 'ghp_write', GITHUB_READ_TOKEN: 'ghp_read' });
    const env = codingEnv(c);
    expect(env.GH_TOKEN).toBe('ghp_write');
    expect(env.GITHUB_TOKEN).toBe('ghp_write');
    expect(env.GITHUB_READ_TOKEN).toBeUndefined();
  });

  it('repoints HOME/USER at the coding home only when a uid is dropped', () => {
    // dev (no uid): inherit the loop's HOME — no override.
    const dev = codingEnv(loadConfig({}));
    expect(dev.HOME).toBe(process.env.HOME);
    expect(dev.USER).toBe(process.env.USER);
    // uid dropped: HOME/USER point at the robot home the image created.
    const dropped = codingEnv(loadConfig({ ROBOT_CODING_UID: '1500', ROBOT_CODING_HOME: '/home/robot' }));
    expect(dropped.HOME).toBe('/home/robot');
    expect(dropped.USER).toBe('robot');
    expect(dropped.LOGNAME).toBe('robot');
  });

  it('sets proxy vars only when a proxy is configured', () => {
    expect(codingEnv(loadConfig({})).HTTPS_PROXY).toBeUndefined();
    const env = codingEnv(loadConfig({ HTTPS_PROXY: 'http://egress-proxy:3128' }));
    expect(env.HTTPS_PROXY).toBe('http://egress-proxy:3128');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });
});

describe('readHandoff', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-ho-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports no hand-off on a bare tree', () => {
    expect(readHandoff(dir)).toEqual({ verifyOk: false, prNumber: undefined });
  });

  it('reads the verify-ok marker and PR number from scm.json', () => {
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, VERIFY_OK_MARKER), '');
    writeFileSync(path.join(dir, SCM_JSON), JSON.stringify({ pr_number: 314, branch: 'robot/220' }));
    expect(readHandoff(dir)).toEqual({ verifyOk: true, prNumber: 314 });
  });

  it('tolerates a malformed scm.json', () => {
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, SCM_JSON), 'not json');
    expect(readHandoff(dir)).toEqual({ verifyOk: false, prNumber: undefined });
  });

  it('reads the ask-human question when the Robot parked for a human (C2)', () => {
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, ASK_HUMAN_MARKER), 'Should this use the new or old API?\n');
    expect(readHandoff(dir).askHuman).toBe('Should this use the new or old API?');
  });
});

describe('runRobotSession', () => {
  let dir: string;
  let config: AgentWorkerConfig;
  let worktree: Worktree;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-sess-'));
    config = loadConfig({});
    worktree = { dir, branch: 'robot/220' };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a clean run + hand-off when the session succeeds and leaves the markers', async () => {
    const fake: RunQuery = (async function* () {
      // simulate the Robot completing its Finish steps
      mkdirSync(path.join(dir, '.robot'), { recursive: true });
      writeFileSync(path.join(dir, VERIFY_OK_MARKER), '');
      writeFileSync(path.join(dir, SCM_JSON), JSON.stringify({ pr_number: 99 }));
      yield { type: 'system', subtype: 'init', session_id: 'sess-abc' } as never;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-abc',
        num_turns: 6,
        usage: { input_tokens: 1000, output_tokens: 234 },
      } as never;
    }) as unknown as RunQuery;

    const res = await runRobotSession(config, candidate, worktree, fake);
    // C3 metrics: turns + total tokens captured off the result message.
    expect(res).toMatchObject({ ok: true, sessionId: 'sess-abc', verifyOk: true, prNumber: 99, turns: 6, tokens: 1234 });
  });

  it('reports !ok with the error text on an API error, and no hand-off', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'result', subtype: 'error_max_turns', session_id: 's', errors: ['max turns'] } as never;
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, fake);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('max turns');
    expect(res.verifyOk).toBe(false);
  });

  it('catches a thrown session and surfaces it as an error result', async () => {
    const fake: RunQuery = (() => {
      throw new Error('spawn EACCES');
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, fake);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('EACCES');
  });
});
