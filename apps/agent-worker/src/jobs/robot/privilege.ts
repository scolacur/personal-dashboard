import { spawn as nodeSpawn } from 'node:child_process';
import { statSync, type Stats } from 'node:fs';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AgentWorkerConfig } from '../../shared/config';

/**
 * The uid privilege-split (D-055) — enforced by the OS kernel, NOT by prompting the Robot.
 *
 * Two structural layers, neither of which trusts the coding agent to behave:
 *   1. The coding subprocess is spawned with a low-privilege `{ uid, gid }` (below). The kernel
 *      sets the process's real+effective uid before `claude` execs; nothing in-session can raise
 *      it back. This is the deterministic drop.
 *   2. `dashboard.db` is mode-600 owned by the loop's uid, so any `open()` from the coding uid
 *      returns EACCES at the syscall. `checkDbLockedFromCoder` verifies this invariant BEFORE
 *      dispatch, so a mis-permissioned deploy fails closed instead of running a Robot that could
 *      read the board. Together they enforce D-039 physically: a Robot cannot touch the queue.
 *
 * When no coding uid is configured (local dev, where we can't drop privileges), the spawn runs
 * as the same uid and the DB check is a no-op — the split is a container-only guarantee, and the
 * unit tests below assert the *mechanism* is wired, not that macOS enforces it.
 */

/**
 * Build the SDK `spawnClaudeCodeProcess` hook that runs the `claude` subprocess under the
 * configured low-priv uid/gid. `spawnFn` is injectable for tests (default: node spawn).
 */
export function makeCodingSpawn(
  config: AgentWorkerConfig,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): (options: SpawnOptions) => SpawnedProcess {
  const { codingUid, codingGid } = config.robot;
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Kernel-enforced privilege drop. Omitted (undefined) in dev ⇒ inherit the loop's uid.
      ...(codingUid !== undefined ? { uid: codingUid } : {}),
      ...(codingGid !== undefined ? { gid: codingGid } : {}),
    });
    // A Node ChildProcess with piped stdio structurally satisfies SpawnedProcess; the SDK only
    // uses stdin/stdout/kill/exit which are non-null under 'pipe'.
    return child as unknown as SpawnedProcess;
  };
}

export interface DbLockCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Verify `dashboard.db` is unreadable by the coding uid — the precondition that turns the
 * uid-split from "documented" into a checked invariant. Only meaningful when a coding uid is
 * configured; in dev it returns ok (nothing to enforce). Injectable stat/getuid for tests.
 */
export function checkDbLockedFromCoder(
  dbPath: string,
  config: AgentWorkerConfig,
  deps: { stat?: (p: string) => Stats; getuid?: () => number } = {},
): DbLockCheck {
  const { codingUid } = config.robot;
  if (codingUid === undefined) return { ok: true }; // no privilege drop configured (dev)

  const stat = deps.stat ?? statSync;
  const getuid = deps.getuid ?? (typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined);

  let st: Stats;
  try {
    st = stat(dbPath);
  } catch {
    return { ok: false, reason: `cannot stat ${dbPath}` };
  }

  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return { ok: false, reason: `dashboard.db mode 0${mode.toString(8)} grants group/other access` };
  }
  const owner = st.uid;
  const loopUid = getuid ? getuid() : owner;
  if (owner !== loopUid) {
    return { ok: false, reason: `dashboard.db owner uid ${owner} != loop uid ${loopUid}` };
  }
  if (codingUid === owner) {
    return { ok: false, reason: `coding uid ${codingUid} equals db owner — no split` };
  }
  return { ok: true };
}
