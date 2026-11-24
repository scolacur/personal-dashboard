import type Database from 'better-sqlite3';
import { habitTrackerIsEmpty, seedHabitTracker } from './habit-tracker';
import { seedTaskTracker, taskTrackerIsEmpty } from './task-tracker';
import { seedTicketSuggestions, ticketSuggestionsIsEmpty } from './ticket-suggestions';

/**
 * Visual-capture fixtures (PD-798): sample data loaded into the EMPTY scratch database a visual
 * capture runs the PR's server against, so data-driven UI actually renders in the screenshots.
 *
 * Two locks keep this off real data:
 *  1. it runs only when `VISUAL_FIXTURES=1`, which only the worker's capture step sets;
 *  2. each fixture runs only when its own tables are empty, so even a mis-set flag on a populated
 *     database writes nothing.
 *
 * A PR that adds UI needing data adds or extends its widget's fixture here, in the same diff, so the
 * Evaluator reviews the fixture like any other code. Each fixture has a spec that runs it against a
 * freshly bootstrapped database, so a schema change that breaks one fails `npm run verify`.
 */

export const VISUAL_FIXTURES_ENV = 'VISUAL_FIXTURES';

export interface VisualFixture {
  name: string;
  isEmpty(db: Database.Database): boolean;
  seed(db: Database.Database, now: number): void;
}

export const VISUAL_FIXTURES: VisualFixture[] = [
  { name: 'habit-tracker', isEmpty: habitTrackerIsEmpty, seed: seedHabitTracker },
  { name: 'task-tracker', isEmpty: taskTrackerIsEmpty, seed: (db) => seedTaskTracker(db) },
  { name: 'ticket-suggestions', isEmpty: ticketSuggestionsIsEmpty, seed: seedTicketSuggestions },
];

/** Seed every fixture whose tables are empty. Returns the names seeded. Each runs in a transaction. */
export function seedVisualFixtures(
  db: Database.Database,
  now: number = Date.now(),
  fixtures: readonly VisualFixture[] = VISUAL_FIXTURES,
): string[] {
  const seeded: string[] = [];
  for (const f of fixtures) {
    if (!f.isEmpty(db)) continue;
    db.transaction(() => f.seed(db, now))();
    seeded.push(f.name);
  }
  return seeded;
}

/** The boot hook: seed only when the capture step asked for it. */
export function seedVisualFixturesFromEnv(db: Database.Database, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env[VISUAL_FIXTURES_ENV] !== '1') return [];
  return seedVisualFixtures(db);
}
