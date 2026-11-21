import type { Worktree } from './workspace';

/**
 * The live worker's in-flight run registry (PD-784, D-104).
 *
 * The stall watchdog used to decide "is this `running` row an orphan?" from AGE alone: a run whose
 * `started_at` was older than `stallThresholdMs` (default 2h) was reclaimed, anything younger was
 * left. That is wrong in both directions now that a run can outlive a cycle:
 *
 *  - **Too slow on a restart.** When the container is recreated (every deploy), the new worker does
 *    not own the runs the dead one left `running`, yet each waits out the full 2h from its own
 *    `started_at` before being reclaimed — filling every slot and dispatching nothing meanwhile
 *    (the 2026-11-20 incident: four runs stranded ~1.5h).
 *  - **Too eager on a live run.** A run of the LIVE process that legitimately passes 2h gets closed
 *    as an orphan and its ticket re-queued while the session is still working — a double dispatch.
 *
 * The honest question is ownership, not age: *does the process now running own this run?* Only the
 * live worker writes `agent_runs`, and it knows exactly which run ids it is executing (this
 * registry). A `running` row whose id this registry does not hold was started by a previous
 * incarnation that is gone — a **process-restart orphan**, reclaimable immediately. A run it DOES
 * hold is never an orphan, however old; age survives only as a hung-session backstop, measured from
 * the last observed progress (not `started_at`), so a session that is still making turns is never
 * touched.
 *
 * In-memory on purpose: the one fact that cannot be recovered after a restart is "which runs is THIS
 * process executing", and after a restart the answer is "none" — which is exactly what makes every
 * pre-existing `running` row an orphan. Nothing here is persisted.
 */

/** Bookkeeping the live worker keeps for one run it is executing. */
export interface OwnedRun {
  runId: number;
  ticketId: number;
  branch: string;
  /** When the loop opened the run row (epoch ms). */
  startedAt: number;
  /** When the session last reported progress (a turn), or `startedAt` if it never has. The
   *  hung-session backstop measures staleness from here, so a session still emitting turns is safe. */
  lastProgressAt: number;
  /** The worktree the session runs in, attached once `ensureWorktree` returns — so a graceful stop
   *  can push its WIP (PD-737) before the clone is dropped. */
  worktree?: Worktree;
  /** Aborts the in-flight SDK session on a graceful stop (SIGTERM). */
  abort: AbortController;
}

export interface RunOwnership {
  /** When this worker process started (epoch ms). A `running` row older than this was necessarily
   *  opened by a previous incarnation — a cheap cross-check on the ownership-set answer. */
  readonly processStartedAt: number;
  /** Register a run this process has just opened and is about to execute. */
  begin(input: { runId: number; ticketId: number; branch: string; abort: AbortController }, now: number): void;
  /** Attach the worktree once it exists, so shutdown can reach it for a WIP push. */
  attachWorktree(runId: number, worktree: Worktree): void;
  /** Record live progress (a turn) on an owned run — resets its hung-session clock. */
  progress(runId: number, now: number): void;
  /** Forget a run once it has finished (any terminal outcome). Idempotent. */
  end(runId: number): void;
  /** Does the live process own (is it executing) this run? */
  owns(runId: number): boolean;
  /** Last progress ts for an owned run, else undefined. */
  lastProgressAt(runId: number): number | undefined;
  /** The owned run record, for callers that need its abort controller / worktree. */
  get(runId: number): OwnedRun | undefined;
  /** Every run this process currently has in flight — the set a graceful stop aborts. */
  inFlight(): OwnedRun[];
}

export function createRunOwnership(processStartedAt: number = Date.now()): RunOwnership {
  const runs = new Map<number, OwnedRun>();
  return {
    processStartedAt,
    begin({ runId, ticketId, branch, abort }, now) {
      runs.set(runId, { runId, ticketId, branch, startedAt: now, lastProgressAt: now, abort });
    },
    attachWorktree(runId, worktree) {
      const r = runs.get(runId);
      if (r) r.worktree = worktree;
    },
    progress(runId, now) {
      const r = runs.get(runId);
      if (r) r.lastProgressAt = now;
    },
    end(runId) {
      runs.delete(runId);
    },
    owns(runId) {
      return runs.has(runId);
    },
    lastProgressAt(runId) {
      return runs.get(runId)?.lastProgressAt;
    },
    get(runId) {
      return runs.get(runId);
    },
    inFlight() {
      return [...runs.values()];
    },
  };
}
