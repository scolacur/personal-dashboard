import type Database from 'better-sqlite3';
import { REFINE_EVENT_TYPE, type CreateTicketInput } from '@dashboard/shared';
import { createTicket, updateTicket } from '../widgets/task-monitor/store';

/**
 * Task Tracker fixture (PD-798): a small board with every lane and every Robot state on it, so the
 * board, the status pills and the "needs you" modal (PD-738) all have something to show.
 *
 * Tickets go through the store's `createTicket`/`updateTicket`. The Robot's state (`agent_state`)
 * and a Refine agent turn (an event) are worker-written and have no store setter, so they are written
 * directly; the fixture's spec reads them back through `listTickets`, which is what breaks first if
 * either changes shape.
 */

function projectId(db: Database.Database): number {
  const row = db.prepare("SELECT id FROM agent_projects WHERE key = 'PD'").get() as { id: number } | undefined;
  if (!row) throw new Error('visual fixture: the PD project is missing (task-monitor schema not bootstrapped?)');
  return row.id;
}

export function seedTaskTracker(db: Database.Database): void {
  const pd = projectId(db);
  const setAgent = db.prepare('UPDATE agent_tickets SET agent_state = ? WHERE id = ?');
  const refineAsks = db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  );

  const epic = createTicket(db, { title: 'Habit Tracker — metrics and calendar', projectId: pd, isEpic: true, priority: 'P1' });

  const t = (title: string, extra: Partial<CreateTicketInput> = {}) =>
    createTicket(db, { title, projectId: pd, priority: 'P2', ...extra });

  // Backlog: an unrefined idea, a refined Robot ticket, and one waiting on Steve's Refine answer.
  t('Export habit history as CSV');
  const refinedRobot = t('Weekly summary card on Today', { assignee: 'robot', epicId: epic.id });
  updateTicket(db, refinedRobot.id, { refined: true });
  const awaitingRefine = t('Reminders for habits not done by evening', { epicId: epic.id });
  refineAsks.run(
    awaitingRefine.id,
    REFINE_EVENT_TYPE.agent,
    JSON.stringify({ text: 'Should a reminder fire for a per-week habit that is already on track this week?' }),
    Date.now(),
  );

  // Queue: one per Robot state the board draws differently.
  const states: [string, string, string][] = [
    ['Metric values on the Log calendar', 'queued', 'P1'],
    ['Choice metric: multi-select chips', 'working', 'P1'],
    ['By-habit calendar streak stats', 'in-review', 'P2'],
    ['Time metric picker on phone', 'stuck', 'P1'],
    ['Archive a habit without losing history', 'needs-human', 'P2'],
    ['Number metric units', 'awaiting-human', 'P3'],
  ];
  for (const [title, state, priority] of states) {
    const ticket = t(title, { assignee: 'robot', epicId: epic.id, priority: priority as CreateTicketInput['priority'] });
    updateTicket(db, ticket.id, { refined: true });
    updateTicket(db, ticket.id, { status: 'queue' });
    setAgent.run(state, ticket.id);
  }
  const mine = t('Pick the default day boundary', { assignee: 'steve' });
  updateTicket(db, mine.id, { status: 'queue' });

  // Done.
  const done = t('Habit Tracker tracer slice', { assignee: 'robot', epicId: epic.id });
  updateTicket(db, done.id, { refined: true });
  updateTicket(db, done.id, { status: 'completed' });

  // Last: adding a member resets an Epic's refined flag (D-089), so the Epic is marked refined once
  // its members are all in place. This Epic still has an unrefined open member (`awaitingRefine`),
  // so its board card reads "Plan refined · N/M members" (T979/D-103).
  updateTicket(db, epic.id, { refined: true });

  // T979/D-103: a SECOND Epic whose every open member is refined, so its card reads "Fully refined"
  // (green) — the other half of the plan-vs-members display the badge now draws.
  const fullEpic = createTicket(db, {
    title: 'Pomodoro timer — floating card',
    projectId: pd,
    isEpic: true,
    priority: 'P2',
  });
  for (const title of ['Persist timer across reloads', 'Interval settings bar']) {
    const m = t(title, { assignee: 'robot', epicId: fullEpic.id });
    updateTicket(db, m.id, { refined: true });
  }
  updateTicket(db, fullEpic.id, { refined: true });
}

export function taskTrackerIsEmpty(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM agent_tickets').get() as { n: number }).n === 0;
}
