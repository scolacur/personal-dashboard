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

/** Timestamp of the newest event of `type` for a ticket, or 0 if none. Tolerates a missing events
 *  table (worker booted before the server bootstrapped it) → 0. Read side of the C5 resume sweeps. */
export function latestEventAt(db: Database.Database, ticketId: number, type: RobotEventType): number {
  try {
    const row = db
      .prepare('SELECT MAX(created_at) AS t FROM agent_ticket_events WHERE ticket_id = ? AND type = ?')
      .get(ticketId, type) as { t: number | null } | undefined;
    return row?.t ?? 0;
  } catch {
    return 0;
  }
}

/** The newest event of `type` for a ticket (detail parsed), or null. Used to recover the ask_human
 *  question + the human's answer for the resume prompt. */
export function latestEvent(
  db: Database.Database,
  ticketId: number,
  type: RobotEventType,
): { createdAt: number; detail: RobotEventDetail } | null {
  try {
    const row = db
      .prepare(
        'SELECT detail, created_at FROM agent_ticket_events WHERE ticket_id = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(ticketId, type) as { detail: string | null; created_at: number } | undefined;
    if (!row) return null;
    let detail: RobotEventDetail = {};
    try {
      detail = row.detail ? (JSON.parse(row.detail) as RobotEventDetail) : {};
    } catch {
      detail = {};
    }
    return { createdAt: row.created_at, detail };
  } catch {
    return null;
  }
}

export { ROBOT_EVENT };
