import type Database from 'better-sqlite3';
import { AUTO_QUEUE_EVENT, REFINE_EVENT_TYPE, type CreateTicketInput } from '@dashboard/shared';
import { createTicket, recordTicketEvent, updateTicket } from '../widgets/task-monitor/store';

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
  // its members are all in place.
  updateTicket(db, epic.id, { refined: true });

  // D-103 (PD-809): one ticket that is auto-queue ELIGIBLE, so the eligibility checklist has a green
  // verdict to photograph. That needs an ACTIVE (queued) Epic whose members are all refined, holding
  // a refined, Ready, robot ticket still in Backlog. Built Epic-first — activated while empty — so
  // adding the member does not arm it (a ticket created into a queued Epic stays in Backlog, D-080).
  const READY_BODY =
    '## Context\nThe Pomodoro timer should be reachable from anywhere.\n\n' +
    '## Task\nAdd a floating timer button pinned to the bottom-right corner.\n\n' +
    '## Done When\nThe button floats on every page and opens the timer.\n\n' +
    '## Out of scope\nThe timer countdown logic itself.';
  const activeEpic = createTicket(db, { title: 'Pomodoro timer', projectId: pd, isEpic: true, priority: 'P2' });
  updateTicket(db, activeEpic.id, { refined: true });
  updateTicket(db, activeEpic.id, { status: 'queue' });
  const eligible = t('Floating Pomodoro button', { assignee: 'robot', epicId: activeEpic.id, body: READY_BODY });
  updateTicket(db, eligible.id, { refined: true });
  // Adding the member re-staled the Epic (D-089); re-mark it so the member clears every criterion.
  updateTicket(db, activeEpic.id, { refined: true });

  // D-103 (PD-811): one ticket the auto-queue promoter moved into the Queue, so the board shows the
  // "🤖 auto-queued" badge. The `auto_queued` event is written AFTER the status change so it wins the
  // card badge's newest-event tiebreak (store `LATEST_REFINE_TYPE_SELECT`).
  const autoQueued = t('Pause/resume the Pomodoro timer', { assignee: 'robot', epicId: activeEpic.id, body: READY_BODY });
  updateTicket(db, autoQueued.id, { refined: true });
  updateTicket(db, activeEpic.id, { refined: true }); // adding the member re-staled the Epic; re-settle
  updateTicket(db, autoQueued.id, { status: 'queue' });
  recordTicketEvent(db, autoQueued.id, AUTO_QUEUE_EVENT.queued, {
    mode: 'on',
    epicId: activeEpic.id,
    criteria: [],
    capacity: [],
  });
}

export function taskTrackerIsEmpty(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM agent_tickets').get() as { n: number }).n === 0;
}
