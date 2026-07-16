import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type RobotEventType, type RobotEventDetail } from '@dashboard/shared';
import { logger } from '../../shared/logger';

/**
 * Robot milestone events (D-055, PD-344 / C3). The loop records each significant transition
 * (dispatched / hand-off / fault / park / ask_human / paused) onto the SAME `agent_ticket_events`
 * timeline the Refine thread uses — reuse, not a parallel log. The ticket-detail activity timeline
 * and Site Status read them back. Written by the loop (the sole DB writer); the coding session
 * (uid-split) never touches the DB.
 *
 * Same table + insert shape as the refine writers (refine.ts) so the two processes stay in lockstep.
 * Best-effort: a failed event write (e.g. the server hasn't bootstrapped the table yet) is logged
 * and swallowed — observability must never break a dispatch.
 */
export function logMilestone(
  db: Database.Database,
  ticketId: number,
  type: RobotEventType,
  detail: RobotEventDetail = {},
  now: number = Date.now(),
): void {
  try {
    db.prepare(
      'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
    ).run(ticketId, type, JSON.stringify(detail), now);
  } catch (err) {
    logger.warn({ err, ticketId, type }, 'robot: milestone event write failed (non-fatal)');
  }
}

export { ROBOT_EVENT };
