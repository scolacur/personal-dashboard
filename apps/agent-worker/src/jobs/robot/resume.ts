import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import { logger } from '../../shared/logger';
import { latestEvent, latestEventAt, logMilestone } from './events';
import { setAgentState } from './board';

/**
 * ask_human resume (D-055, C5/PD-346) — the Robot loop's DB-native ask_human handoff (it replaced
 * the retired `sortie-ask-human` GitHub Action). When a Robot parks a ticket `awaiting-human` it records a `robot_ask_human` event with its
 * question. The human answers via the Notification-Center inline reply, which the server records as a
 * `robot_human_reply` event (see `appendRobotReply`). This sweep detects that answer entirely from
 * `dashboard.db` — no GitHub issue round-trip, no label flip — re-queues the ticket, and the answer
 * is handed to the (DB-blind) coding session via the resume prompt.
 */

export interface AskHumanResume {
  /** The question the Robot asked (from the newest `robot_ask_human` event), or null. */
  question: string | null;
  /** The human's answer (from the newest `robot_human_reply` event). */
  answer: string;
}

/**
 * The resume context for a ticket IF a human answer has landed that a later dispatch hasn't yet
 * consumed — the newest `robot_human_reply` must post-date BOTH the newest `robot_ask_human` (the
 * answer is to the current question) AND the newest `robot_dispatched` (the answer wasn't already
 * fed to an earlier run). Returns `{question, answer}`, else null.
 *
 * Pure read. Called by the resume sweep (to flip `awaiting-human` → `queued`) and at dispatch time
 * BEFORE the new `robot_dispatched` event is written — so a stale answer from a resolved ask_human
 * episode is never re-injected into a later rework run.
 */
export function askHumanResume(db: Database.Database, ticketId: number): AskHumanResume | null {
  const reply = latestEvent(db, ticketId, ROBOT_EVENT.humanReply);
  if (!reply) return null;
  const askAt = latestEventAt(db, ticketId, ROBOT_EVENT.askHuman);
  const dispatchedAt = latestEventAt(db, ticketId, ROBOT_EVENT.dispatched);
  // The reply must answer the current question and not already have been consumed by a dispatch.
  if (reply.createdAt <= askAt) return null;
  if (reply.createdAt <= dispatchedAt) return null;
  const question = latestEvent(db, ticketId, ROBOT_EVENT.askHuman);
  return { question: question?.detail.question ?? null, answer: reply.detail.text ?? '' };
}

/** Robot-assigned queued tickets currently parked `awaiting-human` — the resume sweep's candidate
 *  set (D-058: queue + robot). */
export function ticketsAwaitingHuman(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM agent_tickets
        WHERE archived_at IS NULL AND status = 'queue' AND assignee = 'robot' AND agent_state = 'awaiting-human'`,
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Re-queue every `awaiting-human` ticket whose human answer has landed in the DB. Returns the count
 * resumed. The dispatch that follows this cycle picks the ticket up again (branch reused, prior work
 * intact) and injects the Q&A into the prompt via {@link askHumanResume}.
 */
export function resumeAskHuman(db: Database.Database, now: number = Date.now()): number {
  let resumed = 0;
  for (const ticketId of ticketsAwaitingHuman(db)) {
    const ctx = askHumanResume(db, ticketId);
    if (!ctx) continue;
    setAgentState(db, ticketId, 'queued', now);
    logMilestone(db, ticketId, ROBOT_EVENT.resumed, { reason: 'human answered ask_human' }, now);
    logger.info({ ticketId }, 'robot: ask_human answered — re-queued');
    resumed++;
  }
  return resumed;
}
