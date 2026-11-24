import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type RobotEventType } from '@dashboard/shared';
import { latestEvent } from './events';

/**
 * D-094/PD-737, amended by PD-964 (D-114) — how the next run of a ticket starts, and how many turns
 * its episode has used.
 *
 * **Episode.** The stretch of runs since a human last pointed the Robot at the ticket: a Continue or
 * Restart on a checkpoint, a Reset/Unstick, an answered ask_human, a rework reactivation, or — with no
 * such event — the ticket's whole history. The total turn cap (`checkpointTotalTurns`) is per
 * episode, and it carries across the loop's own automatic retries, which are NOT boundaries: a run
 * cut short by a transient fault (a worker restart, a network flake) resumes its episode, its budget
 * and its window rather than starting over.
 *
 * **How a run starts.** Read at dispatch, BEFORE the new run's row exists:
 *  - `continue` — Steve pressed Continue and no run has started since: restore the saved work, put
 *    the checkpoint's report in the prompt.
 *  - `restart` — Steve pressed Restart and no run has started since: a clean clone from main.
 *  - `retry` — the episode's latest run ended in a transient fault: resume THAT run's saved work
 *    (when it saved any), keep the episode's turns so far, and carry the Continue's report if the
 *    episode began with one. Before PD-964 a Continue was consumed by the first dispatch after it, so
 *    a SIGTERM mid-Continue sent the retry back to a clean tree and default turns, and it rebuilt the
 *    change from scratch (PD-931, 2026-11-23).
 *  - `fresh` — anything else.
 */

/** Events that begin a new episode. Each is a human (or a human's reply) re-pointing the Robot. */
export const EPISODE_BOUNDARY_EVENTS: readonly RobotEventType[] = [
  ROBOT_EVENT.checkpointContinue,
  ROBOT_EVENT.checkpointRestart,
  ROBOT_EVENT.reset,
  ROBOT_EVENT.unstick,
  ROBOT_EVENT.resumed,
  ROBOT_EVENT.reactivated,
];

export interface Episode {
  /** When the episode began (the boundary event's timestamp), or 0 for a ticket's first episode. */
  start: number;
  /** The boundary event that began it, or null for a ticket's first episode. */
  startedBy: RobotEventType | null;
  /** Turns used by this episode's runs so far (finished and in-flight), including judge turns. */
  turnsUsed: number;
}

/** The ticket's current episode. Tolerates a missing events table (→ the whole history). */
export function currentEpisode(db: Database.Database, ticketId: number): Episode {
  let start = 0;
  let startedBy: RobotEventType | null = null;
  try {
    const placeholders = EPISODE_BOUNDARY_EVENTS.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT type, created_at FROM agent_ticket_events
          WHERE ticket_id = ? AND type IN (${placeholders})
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(ticketId, ...EPISODE_BOUNDARY_EVENTS) as { type: RobotEventType; created_at: number } | undefined;
    if (row) {
      start = row.created_at;
      startedBy = row.type;
    }
  } catch {
    // no events table yet — the whole history is one episode
  }
  const used = db
    .prepare('SELECT COALESCE(SUM(turns), 0) AS n FROM agent_runs WHERE ticket_id = ? AND started_at > ?')
    .get(ticketId, start) as { n: number };
  return { start, startedBy, turnsUsed: used.n };
}

export type DispatchStart =
  | { kind: 'fresh' }
  | { kind: 'restart' }
  | {
      kind: 'continue';
      /** The checkpoint's status report, for the prompt. */
      report: string;
    }
  | {
      kind: 'retry';
      /** Restore the WIP ref? Only when the interrupted run itself saved one — otherwise the ref may
       *  still hold work from BEFORE a Restart, which must never come back on its own. */
      restoreWip: boolean;
      /** What the prompt carries over: the episode's Continue report, or the interrupted run's tail. */
      report: string;
    };

/** The checkpoint report this episode's Continue was answering. */
function checkpointReport(db: Database.Database, ticketId: number): string {
  return latestEvent(db, ticketId, ROBOT_EVENT.checkpoint)?.detail.report?.trim() || '(The previous run left no status report.)';
}

/** How the next run of `ticketId` starts. Pure read; call BEFORE `startRun` for the new run. */
export function dispatchStart(db: Database.Database, ticketId: number): DispatchStart {
  const episode = currentEpisode(db, ticketId);
  const last = db
    .prepare(
      `SELECT status, fault_tier, fault_reason, wip_ref, output_tail FROM agent_runs
        WHERE ticket_id = ? AND started_at > ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(ticketId, episode.start) as
    | { status: string; fault_tier: string | null; fault_reason: string | null; wip_ref: string | null; output_tail: string | null }
    | undefined;

  if (!last) {
    if (episode.startedBy === ROBOT_EVENT.checkpointRestart) return { kind: 'restart' };
    if (episode.startedBy === ROBOT_EVENT.checkpointContinue) return { kind: 'continue', report: checkpointReport(db, ticketId) };
    return { kind: 'fresh' };
  }

  // The loop re-queued this ticket itself after a fault that was not the ticket's doing. A
  // deterministic fault parks instead, so it never reaches here without a human boundary.
  const transient = (last.status === 'error' || last.status === 'no-verify') && last.fault_tier !== 'deterministic';
  if (!transient) return { kind: 'fresh' };
  const why = last.fault_reason?.trim() || 'a transient fault';
  const report =
    episode.startedBy === ROBOT_EVENT.checkpointContinue
      ? checkpointReport(db, ticketId)
      : reportFromTail(last.output_tail ?? undefined, `the previous run was cut short (${why})`);
  return { kind: 'retry', restoreWip: last.wip_ref !== null, report };
}

/** The text stored when the report step failed: the output tail, labelled so nobody mistakes it for
 *  the agent's own summary (D-094 §2). */
export function reportFromTail(outputTail: string | undefined, why: string): string {
  const tail = outputTail?.trim();
  return tail
    ? `(No status report — ${why}. The end of the run's output follows instead.)\n\n${tail}`
    : `(No status report — ${why}, and the run left no output.)`;
}

/**
 * The window plan for a run: how long its first window is, and which window number that is. An
 * episode opens with a longer window (`openingTurns`), then checks every `windowTurns` — boundaries
 * at opening, opening+w, opening+2w, … A retry finishes the window it was cut short in (so checks
 * stay aligned to the episode, not to the run), and no window ever runs past the total cap. Pure.
 */
export function firstWindow(
  turnsUsed: number,
  openingTurns: number,
  windowTurns: number,
  totalTurns: number,
): { turns: number; index: number } {
  const o = Math.max(1, openingTurns);
  const w = Math.max(1, windowTurns);
  const left = Math.max(0, totalTurns - turnsUsed);
  if (turnsUsed < o) return { turns: Math.min(o - turnsUsed, left), index: 1 };
  const past = turnsUsed - o;
  return { turns: Math.min(w - (past % w), left), index: Math.floor(past / w) + 2 };
}
