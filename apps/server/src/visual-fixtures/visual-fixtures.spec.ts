import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapHabitsSchema, createItem, getTodayView } from '../lib/habits';
import { autoQueueEligibility } from '@dashboard/shared';
import { bootstrapSchema } from '../widgets/task-monitor/schema';
import { listTickets } from '../widgets/task-monitor/store';
import { listTicketSuggestions } from '../widgets/task-monitor/ticket-suggestions';
import { seedVisualFixtures, seedVisualFixturesFromEnv, VISUAL_FIXTURES, type VisualFixture } from './index';

/** A database bootstrapped the way the server boots one, with nothing in it yet. */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapHabitsSchema(db);
  bootstrapSchema(db);
  return db;
}

const NOW = Date.UTC(2026, 10, 20, 18, 0); // 13:00 in New York, well past the 04:00 day boundary

describe('visual fixtures (PD-798)', () => {
  it('seed every fixture into a fresh database', () => {
    const db = freshDb();
    expect(seedVisualFixtures(db, NOW)).toEqual(VISUAL_FIXTURES.map((f) => f.name));
  });

  it('give the Habit Tracker due habits with streaks and one metric of each type', () => {
    const db = freshDb();
    seedVisualFixtures(db, NOW);
    const today = getTodayView(db, NOW);
    const due = today.rows.filter((r) => r.due);
    expect(due.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...today.rows.map((r) => r.streak.current))).toBeGreaterThanOrEqual(2);
    expect(today.metrics.map((m) => m.item.metricType).sort()).toEqual(['choice', 'number', 'time']);
    // both a filled and an empty input render
    expect(today.metrics.some((m) => m.value === null)).toBe(true);
    expect(today.metrics.some((m) => m.value !== null)).toBe(true);
    expect(today.metrics.find((m) => m.item.metricType === 'choice')!.options.length).toBeGreaterThan(1);
  });

  it('give the Task Tracker every lane and every Robot state the board draws', () => {
    const db = freshDb();
    seedVisualFixtures(db, NOW);
    const tickets = listTickets(db);
    expect(new Set(tickets.map((t) => t.status))).toEqual(new Set(['backlog', 'queue', 'completed']));
    for (const state of ['queued', 'working', 'in-review', 'stuck', 'needs-human', 'awaiting-human']) {
      expect(tickets.some((t) => t.agentState === state)).toBe(true);
    }
    expect(tickets.some((t) => t.refineState === 'awaiting-human')).toBe(true);
    expect(tickets.some((t) => t.isEpic && t.refined)).toBe(true);
  });

  it('includes one auto-queue-ELIGIBLE ticket so the D-103 checklist has a green verdict to show', () => {
    const db = freshDb();
    seedVisualFixtures(db, NOW);
    const tickets = listTickets(db);
    const eligible = tickets.find((t) => t.title === 'Floating Pomodoro button')!;
    const epic = tickets.find((t) => t.id === eligible.epicId)!;
    const members = tickets.filter((t) => t.epicId === epic.id);
    const verdict = autoQueueEligibility({
      ticket: eligible,
      epic: { ...epic, autoQueueExcluded: epic.autoQueueExcluded ?? false },
      members,
      openBlockerIds: [],
      project: { robotEnabled: true, githubRepo: 'scolacur/personal-dashboard' },
    }).verdict;
    expect(verdict).toBe('eligible');
  });

  it('includes one AUTO-QUEUED ticket so the D-103 card badge shows (PD-811)', () => {
    const db = freshDb();
    seedVisualFixtures(db, NOW);
    const tickets = listTickets(db);
    const autoQueued = tickets.filter((t) => t.autoQueued);
    expect(autoQueued).toHaveLength(1);
    expect(autoQueued[0].status).toBe('queue');
  });

  it('includes one auto-queue-EXCLUDED Epic so the D-103 marker shows (PD-808)', () => {
    const db = freshDb();
    seedVisualFixtures(db, NOW);
    const tickets = listTickets(db);
    const excluded = tickets.filter((t) => t.isEpic && t.autoQueueExcluded);
    expect(excluded).toHaveLength(1);
  });

  it('includes one pending Ticket Suggestion with its findings and source ticket (PD-979)', () => {
    const db = freshDb();
    seedVisualFixtures(db, NOW);
    const { items, count } = listTicketSuggestions(db);
    expect(count).toBe(1);
    const pending = items.find((s) => s.status === 'pending')!;
    expect(pending.findings.length).toBeGreaterThanOrEqual(2);
    expect(pending.sourceTicketTitle).toBeTruthy();
    expect(pending.proposedEpicId).not.toBeNull();
  });

  it('never writes into tables that already hold data', () => {
    const db = freshDb();
    createItem(db, { name: 'A real habit' }, NOW);
    expect(seedVisualFixtures(db, NOW)).toEqual(['task-tracker', 'ticket-suggestions']);
    expect(getTodayView(db, NOW).rows.map((r) => r.item.name)).toEqual(['A real habit']);
    expect(seedVisualFixtures(db, NOW)).toEqual([]); // and a second boot is a no-op
  });

  it('runs only when the capture step sets VISUAL_FIXTURES=1', () => {
    const db = freshDb();
    expect(seedVisualFixturesFromEnv(db, {})).toEqual([]);
    expect(seedVisualFixturesFromEnv(db, { VISUAL_FIXTURES: '0' })).toEqual([]);
    expect(listTickets(db)).toEqual([]);
    expect(seedVisualFixturesFromEnv(db, { VISUAL_FIXTURES: '1' }).length).toBe(VISUAL_FIXTURES.length);
  });

  it('rolls a fixture back whole when it throws', () => {
    const db = freshDb();
    const broken: VisualFixture = {
      name: 'broken',
      isEmpty: () => true,
      seed: (d) => {
        createItem(d, { name: 'half-written' }, NOW);
        throw new Error('boom');
      },
    };
    expect(() => seedVisualFixtures(db, NOW, [broken])).toThrow('boom');
    expect(getTodayView(db, NOW).rows).toEqual([]);
  });
});
