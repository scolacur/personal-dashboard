import type Database from 'better-sqlite3';
import type { NotificationKind } from '@dashboard/shared';
import { logger } from '../../shared/logger';

/**
 * Notification Center writes from the Robot loop (D-055, C5/PD-346). When the loop parks a ticket
 * for a human it surfaces a notification so the park is *visible* in the dashboard inbox — an
 * `agent_needs_human` for a stuck/faulted/stalled ticket, or `agent_awaiting_human` for a deliberate
 * ask_human pause. This is the DB-native replacement for sortie-watchdog's @-mention/Discord ping and
 * the github-sync-derived notifications (which key off labels; C6 inverts that).
 *
 * Best-effort: a failed write (e.g. the server hasn't bootstrapped the table yet) is logged and
 * swallowed — surfacing must never break a dispatch cycle. Mirrors the server's `createNotification`
 * dedup guard: an unread notification for the same (ticket, kind) is not duplicated, so a ticket the
 * loop re-sees every cycle is only notified once until the human reads/acts on it.
 */
export function notify(
  db: Database.Database,
  kind: NotificationKind,
  ticketId: number,
  title: string,
  body: string,
  now: number = Date.now(),
): void {
  try {
    const dup = db
      .prepare('SELECT 1 FROM agent_notifications WHERE ticket_id = ? AND kind = ? AND read_at IS NULL')
      .get(ticketId, kind);
    if (dup) return;
    db.prepare(
      'INSERT INTO agent_notifications (kind, ticket_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(kind, ticketId, title, body, now);
  } catch (err) {
    logger.warn({ err, ticketId, kind }, 'robot: notification write failed (non-fatal)');
  }
}

/** A ticket parked needing human intervention (stuck / stalled / deterministic fault). */
export function notifyNeedsHuman(db: Database.Database, ticketId: number, title: string, body: string, now: number = Date.now()): void {
  notify(db, 'agent_needs_human', ticketId, title, body, now);
}

/** A ticket the Robot deliberately paused with an ask_human question. */
export function notifyAwaitingHuman(db: Database.Database, ticketId: number, title: string, body: string, now: number = Date.now()): void {
  notify(db, 'agent_awaiting_human', ticketId, title, body, now);
}
