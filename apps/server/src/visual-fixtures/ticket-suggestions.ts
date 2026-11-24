import type Database from 'better-sqlite3';
import { createTicket } from '../widgets/task-monitor/store';
import { fileTicketSuggestion } from '../widgets/task-monitor/ticket-suggestions';

/**
 * Ticket Suggestions fixture (PD-979, D-116): one pending suggestion so the Decisions inbox's
 * "Ticket suggestions" section renders a card in the screenshots instead of an empty state.
 *
 * Self-contained: it creates its own Epic + source Ticket (both backlog, no Robot state) so it
 * neither depends on nor disturbs the Task Tracker fixture's lane/state assertions, then files a
 * suggestion through the real store path (`fileTicketSuggestion`), bundling two leftover findings.
 */

function projectId(db: Database.Database): number {
  const row = db.prepare("SELECT id FROM agent_projects WHERE key = 'PD'").get() as { id: number } | undefined;
  if (!row) throw new Error('visual fixture: the PD project is missing (task-monitor schema not bootstrapped?)');
  return row.id;
}

export function seedTicketSuggestions(db: Database.Database, now: number = Date.now()): void {
  const pd = projectId(db);

  const epic = createTicket(db, {
    title: 'Music Tracker — matcher quality',
    projectId: pd,
    isEpic: true,
    priority: 'P2',
  });
  const source = createTicket(db, {
    title: 'Fuzzy-match remix titles against the DJ library',
    projectId: pd,
    epicId: epic.id,
    priority: 'P2',
  });

  fileTicketSuggestion(
    db,
    {
      sourceTicketId: source.id,
      prNumber: 1142,
      repo: 'scolacur/personal-dashboard',
      proposedTitle: 'Follow-ups from the remix matcher PR',
      proposedBody:
        '## Context\nThe Evaluator left non-blocking findings open when the matcher PR shipped.\n\n' +
        '## Task\nAddress the bundled findings below.\n\n' +
        '## Done When\nEach finding is resolved or consciously dropped.\n\n' +
        '## Out of scope\nAny new matching heuristics.',
      findings: [
        {
          kind: 'test-gap',
          where: 'apps/server/src/widgets/music-tracker/matcher.ts:88',
          what: 'the featured-artist branch has no unit test',
        },
        {
          kind: 'readability',
          where: 'apps/server/src/widgets/music-tracker/normalize.ts:41',
          what: 'the diacritic-stripping regex would read better as a named helper',
        },
      ],
    },
    now,
  );
}

export function ticketSuggestionsIsEmpty(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM ticket_suggestions').get() as { n: number }).n === 0;
}
