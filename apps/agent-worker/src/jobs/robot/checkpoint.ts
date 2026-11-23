import type Database from 'better-sqlite3';
import { CHECKPOINT_CONTINUE_TURNS_DEFAULT, ROBOT_EVENT } from '@dashboard/shared';
import { latestEvent, latestEventAt } from './events';

/**
 * D-094/PD-737 — how the next run of a checkpointed ticket starts.
 *
 * A run that reaches its turn ceiling parks the ticket in `checkpoint` (robot.ts). Steve answers
 * from the board with **Continue** or **Restart**; the server records that as a
 * `robot_checkpoint_continue` / `robot_checkpoint_restart` event and re-queues the ticket. This is the
 * dispatch-time read of that choice — the same shape as `askHumanResume` (resume.ts): DB-native, and
 * consumed by the next `robot_dispatched`, so a Continue applies to exactly one run and can never be
 * re-applied to a later rework.
 */
export type CheckpointDecision =
  | {
      kind: 'continue';
      /** The turn ceiling the continued run gets. */
      extraTurns: number;
      /** The checkpointed run's status report, for the prompt. */
      report: string;
    }
  | { kind: 'restart' };

/** The unconsumed Continue/Restart for a ticket, or null. Pure read; call BEFORE writing the new
 *  run's `robot_dispatched` event. When both exist, the newer wins. */
export function checkpointDecision(db: Database.Database, ticketId: number): CheckpointDecision | null {
  const dispatchedAt = latestEventAt(db, ticketId, ROBOT_EVENT.dispatched);
  const cont = latestEvent(db, ticketId, ROBOT_EVENT.checkpointContinue);
  const restart = latestEvent(db, ticketId, ROBOT_EVENT.checkpointRestart);
  const live = [cont && { kind: 'continue' as const, e: cont }, restart && { kind: 'restart' as const, e: restart }]
    .filter((x): x is NonNullable<typeof x> => !!x && x.e.createdAt > dispatchedAt)
    .sort((a, b) => b.e.createdAt - a.e.createdAt)[0];
  if (!live) return null;
  if (live.kind === 'restart') return { kind: 'restart' };
  const checkpoint = latestEvent(db, ticketId, ROBOT_EVENT.checkpoint);
  const extraTurns = live.e.detail.extraTurns;
  return {
    kind: 'continue',
    extraTurns: typeof extraTurns === 'number' && extraTurns > 0 ? extraTurns : CHECKPOINT_CONTINUE_TURNS_DEFAULT,
    report: checkpoint?.detail.report?.trim() || '(The previous run left no status report.)',
  };
}

/** The text stored when the report step failed: the output tail, labelled so nobody mistakes it for
 *  the agent's own summary (D-094 §2). */
export function reportFromTail(outputTail: string | undefined, why: string): string {
  const tail = outputTail?.trim();
  return tail
    ? `(No status report — ${why}. The end of the run's output follows instead.)\n\n${tail}`
    : `(No status report — ${why}, and the run left no output.)`;
}
