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
  // stat that returns the given mode/uid/gid for the main db, and (optionally) different attrs
  // for the -wal/-shm sidecars; sidecars absent (throw) unless `sidecar` is given.
  const stat =
    (mode: number, uid: number, gid: number, sidecar?: { mode: number; uid: number; gid: number }) =>
    (p: string): Stats => {
      if (p.endsWith('-wal') || p.endsWith('-shm')) {
        if (!sidecar) throw new Error('ENOENT');
        return sidecar as Stats;
      }
      return { mode, uid, gid } as Stats;
    };

  const coder = { ROBOT_CODING_UID: '1500', ROBOT_CODING_GID: '1500' };

  it('is a no-op when no coding uid is configured (dev)', () => {
    expect(checkDbLockedFromCoder('/db', cfg({})).ok).toBe(true);
  });

  it('passes on the real deploy shape: 660 owned by the web uid, coding uid/gid excluded', () => {
    // Steve:users (1000:100), mode 660, coding robot 1500:1500 — the actual NAS layout.
    const res = checkDbLockedFromCoder('/db', cfg(coder), { stat: stat(0o660, 1000, 100) });
    expect(res.ok).toBe(true);
  });

  it('passes at 600 too', () => {
    expect(checkDbLockedFromCoder('/db', cfg(coder), { stat: stat(0o600, 1000, 100) }).ok).toBe(true);
  });

  it('fails closed when the db is world-accessible (e.g. the pre-lock 666)', () => {
    const res = checkDbLockedFromCoder('/db', cfg(coder), { stat: stat(0o666, 1000, 100) });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/world-accessible/);
  });

  it('fails closed when the coding uid owns the db', () => {
    const res = checkDbLockedFromCoder('/db', cfg(coder), { stat: stat(0o600, 1500, 100) });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/owned by the coding uid/);
  });

  it('fails closed when the coding gid is the db group with group access', () => {
    const res = checkDbLockedFromCoder('/db', cfg(coder), { stat: stat(0o660, 1000, 1500) });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/coding gid/);
  });

  it('still checks the WAL/-shm sidecars (main locked, sidecar world-readable → fail)', () => {
    const res = checkDbLockedFromCoder('/db', cfg(coder), {
      stat: stat(0o660, 1000, 100, { mode: 0o664, uid: 1000, gid: 100 }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/-wal|-shm/);
  });

  it('fails closed when the db cannot be stat-ed', () => {
    const res = checkDbLockedFromCoder('/db', cfg(coder), {
      stat: () => {
        throw new Error('ENOENT');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot stat/);
  });
});
