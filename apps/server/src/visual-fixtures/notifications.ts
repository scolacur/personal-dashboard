import type Database from 'better-sqlite3';
import { createNotification } from '../widgets/task-monitor/store';

/**
 * Notifications fixture (PD-851): a couple of Notification Center entries so the bell dropdown and
 * `/notifications` render real rows in the screenshots instead of the empty state — including the
 * new ticketless `audit_complete` entry, whose whole point is that it is now clickable (links to
 * the Ticket Audit report) despite having no ticket attached.
 *
 * Written through the store's own `createNotification` so a schema change that breaks it fails this
 * fixture's spec rather than silently producing an empty screenshot.
 */

export function notificationsIsEmpty(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS c FROM agent_notifications').get() as { c: number };
  return row.c === 0;
}

export function seedNotifications(db: Database.Database, now: number): void {
  // The ticketless audit-complete entry (PD-851) — clickable via notificationHref's kind routing.
  createNotification(db, {
    kind: 'audit_complete',
    ticketId: null,
    title: 'Ticket Audit complete — 3 findings to review',
    body: 'Run #42 surfaced 3 actionable findings.',
  });
  // A second, read notification so the list shows more than one row and the read/unread split renders.
  const second = createNotification(db, {
    kind: 'audit_complete',
    ticketId: null,
    title: 'Ticket Audit complete — 1 finding to review',
    body: 'Run #41 surfaced 1 actionable finding.',
  });
  if (second) {
    db.prepare('UPDATE agent_notifications SET read_at = ?, created_at = ? WHERE id = ?').run(
      now,
      now - 60_000,
      second.id,
    );
  }
}
