import { describe, it, expect } from 'vitest';
import type { Stats } from 'node:fs';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { makeCodingSpawn, checkDbLockedFromCoder } from './privilege';

const cfg = (env: Record<string, string> = {}): AgentWorkerConfig => loadConfig(env);

const spawnOpts = (over: Partial<SpawnOptions> = {}): SpawnOptions => ({
  command: 'claude',
  args: ['-p'],
  cwd: '/wt',
  env: { PATH: '/usr/bin' },
  signal: new AbortController().signal,
  ...over,
});

describe('makeCodingSpawn (uid privilege-split)', () => {
  it('drops to the configured uid/gid at spawn', () => {
    let seen: unknown;
    const fake = ((cmd: string, args: string[], opts: unknown) => {
      seen = opts;
      return {} as never;
    }) as never;
    const spawn = makeCodingSpawn(cfg({ ROBOT_CODING_UID: '1500', ROBOT_CODING_GID: '1600' }), fake);
    spawn(spawnOpts());
    expect(seen).toMatchObject({ uid: 1500, gid: 1600, cwd: '/wt', stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('omits uid/gid in dev (no privilege drop configured)', () => {
    let seen: Record<string, unknown> = {};
    const fake = ((_c: string, _a: string[], opts: Record<string, unknown>) => {
      seen = opts;
      return {} as never;
    }) as never;
    makeCodingSpawn(cfg({}), fake)(spawnOpts());
    expect('uid' in seen).toBe(false);
    expect('gid' in seen).toBe(false);
  });

  it('forwards command, args, env and the abort signal', () => {
    let seen: { cmd?: string; args?: string[]; opts?: Record<string, unknown> } = {};
    const fake = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      seen = { cmd, args, opts };
      return {} as never;
    }) as never;
    const sig = new AbortController().signal;
    makeCodingSpawn(cfg({ ROBOT_CODING_UID: '1500' }), fake)(
      spawnOpts({ command: 'x', args: ['a', 'b'], env: { K: 'v' }, signal: sig }),
    );
    expect(seen.cmd).toBe('x');
    expect(seen.args).toEqual(['a', 'b']);
    expect(seen.opts?.env).toEqual({ K: 'v' });
    expect(seen.opts?.signal).toBe(sig);
  });
});

describe('checkDbLockedFromCoder (fail-closed DB precondition)', () => {
  const stat = (mode: number, uid: number): ((p: string) => Stats) =>
    (() => ({ mode, uid }) as Stats);

  it('is a no-op when no coding uid is configured (dev)', () => {
    expect(checkDbLockedFromCoder('/db', cfg({})).ok).toBe(true);
  });

  it('passes when db is 600, owned by the loop uid, coding uid differs', () => {
    const res = checkDbLockedFromCoder('/db', cfg({ ROBOT_CODING_UID: '1500' }), {
      stat: stat(0o600, 1000),
      getuid: () => 1000,
    });
    expect(res.ok).toBe(true);
  });

  it('fails closed when group/other can access the db', () => {
    const res = checkDbLockedFromCoder('/db', cfg({ ROBOT_CODING_UID: '1500' }), {
      stat: stat(0o640, 1000),
      getuid: () => 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/group\/other/);
  });

  it('fails closed when the db is not owned by the loop uid', () => {
    const res = checkDbLockedFromCoder('/db', cfg({ ROBOT_CODING_UID: '1500' }), {
      stat: stat(0o600, 2000),
      getuid: () => 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/owner uid/);
  });

  it('fails closed when the coding uid equals the db owner (no real split)', () => {
    const res = checkDbLockedFromCoder('/db', cfg({ ROBOT_CODING_UID: '1000' }), {
      stat: stat(0o600, 1000),
      getuid: () => 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/equals db owner/);
  });

  it('fails closed when the db cannot be stat-ed', () => {
    const res = checkDbLockedFromCoder('/db', cfg({ ROBOT_CODING_UID: '1500' }), {
      stat: () => {
        throw new Error('ENOENT');
      },
      getuid: () => 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot stat/);
  });
});
