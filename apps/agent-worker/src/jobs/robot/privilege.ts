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

/** Is this one file unreadable by the coding uid/gid? The coding session reaches a file as
 *  "other" (it is neither the db's owner nor — by our image setup — in its group), so the file
 *  is locked away from it iff: no world access, the coding uid isn't the owner, and the coding
 *  gid isn't the owning group with group access. This deliberately does NOT require the LOOP to
 *  own the file — the loop reaches it as root (DAC override) or as the owner; only the coding
 *  uid must be excluded. */
function fileLockedFromCoder(
  path: string,
  st: Stats,
  codingUid: number,
  codingGid: number | undefined,
): DbLockCheck {
  const mode = st.mode & 0o777;
  if ((mode & 0o007) !== 0) {
    return { ok: false, reason: `${path} is world-accessible (mode 0${mode.toString(8)})` };
  }
  if (st.uid === codingUid) {
    return { ok: false, reason: `${path} is owned by the coding uid ${codingUid}` };
  }
  if (codingGid !== undefined && st.gid === codingGid && (mode & 0o070) !== 0) {
    return { ok: false, reason: `${path} group is the coding gid ${codingGid} with group access` };
  }
  return { ok: true };
}

/**
 * Verify `dashboard.db` (and its `-wal`/`-shm` sidecars, which carry board data too) are
 * unreadable by the coding uid — the precondition that turns the uid-split from "documented"
 * into a checked invariant, fail-closed before dispatch. Only meaningful when a coding uid is
 * configured; in dev it returns ok. Injectable stat for tests.
 *
 * Note it does NOT require the loop to own the DB: in the real deploy the DB is owned by the
 * web app's uid and the loop reaches it as root. The check is purely "the coding uid can't."
 */
export function checkDbLockedFromCoder(
  dbPath: string,
  config: AgentWorkerConfig,
  deps: { stat?: (p: string) => Stats } = {},
): DbLockCheck {
  const { codingUid, codingGid } = config.robot;
  if (codingUid === undefined) return { ok: true }; // no privilege drop configured (dev)

  const stat = deps.stat ?? statSync;

  let mainSt: Stats;
  try {
    mainSt = stat(dbPath);
  } catch {
    return { ok: false, reason: `cannot stat ${dbPath}` };
  }

  const main = fileLockedFromCoder(dbPath, mainSt, codingUid, codingGid);
  if (!main.ok) return main;

  // WAL/-shm may be absent at rest (only present while a connection is open); check any that
  // exist. SQLite recreates them from the main db's mode, so a locked main db keeps them locked.
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    let st: Stats;
    try {
      st = stat(p);
    } catch {
      continue; // absent sidecar — nothing to check
    }
    const side = fileLockedFromCoder(p, st, codingUid, codingGid);
    if (!side.ok) return side;
  }

  return { ok: true };
}
