import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { BUG_TITLE, bootstrapSchema } from './schema';
import {
  approveRefine,
  createTicket,
  getProjectBySlug,
  getTicket,
  listTickets,
  updateTicket,
  ValidationError,
} from './store';
import type { TicketKind } from '@dashboard/shared';

/** PD-896 — ticket kind (bug | feature | chore): storage, validation, backfill, Refine. */

const ROBOT_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function seedProposal(db: Database.Database, ticketId: number, proposal: unknown): void {
  db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(ticketId, 'refine_proposal', JSON.stringify(proposal), Date.now());
}

let db: Database.Database;
let pd: number;
beforeEach(() => {
  db = freshDb();
  pd = getProjectBySlug(db, 'personal-dashboard')!.id;
});

describe('ticket kind', () => {
  it('defaults to unclassified, and is set / changed / cleared through create and update', () => {
    expect(createTicket(db, { title: 'x', projectId: pd }).kind).toBeNull();
    const t = createTicket(db, { title: 'y', projectId: pd, kind: 'bug' });
    expect(getTicket(db, t.id)!.kind).toBe('bug');
    expect(updateTicket(db, t.id, { kind: 'chore' })!.kind).toBe('chore');
    expect(updateTicket(db, t.id, { title: 'renamed' })!.kind).toBe('chore'); // omitted = unchanged
    expect(updateTicket(db, t.id, { kind: null })!.kind).toBeNull();
  });

  it('rejects a value outside bug / feature / chore', () => {
    expect(() =>
      createTicket(db, { title: 'x', projectId: pd, kind: 'epic' as TicketKind }),
    ).toThrow(ValidationError);
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(() => updateTicket(db, t.id, { kind: 'Bug' as TicketKind })).toThrow(ValidationError);
  });

  it('refine_in_place may classify the ticket; omitting kind leaves it alone', () => {
    const t = createTicket(db, { title: 'x', projectId: pd, kind: 'feature' });
    seedProposal(db, t.id, { mode: 'refine_in_place', body: ROBOT_BODY });
    expect(approveRefine(db, t.id).ok).toBe(true);
    expect(getTicket(db, t.id)!.kind).toBe('feature');

    const u = createTicket(db, { title: 'u', projectId: pd });
    seedProposal(db, u.id, { mode: 'refine_in_place', body: ROBOT_BODY, kind: 'bug' });
    expect(approveRefine(db, u.id).ok).toBe(true);
    expect(getTicket(db, u.id)!.kind).toBe('bug');
  });

  it("a decompose child takes its own kind, or inherits the parent's when it has none", () => {
    const parent = createTicket(db, { title: 'big bug', projectId: pd, kind: 'bug' });
    seedProposal(db, parent.id, {
      mode: 'decompose',
      children: [
        { title: 'repro', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' },
        { title: 'docs', body: ROBOT_BODY, status: 'backlog', assignee: 'robot', kind: 'chore' },
      ],
    });
    expect(approveRefine(db, parent.id).ok).toBe(true);
    const byTitle = Object.fromEntries(listTickets(db).map((t) => [t.title, t.kind]));
    expect(byTitle.repro).toBe('bug');
    expect(byTitle.docs).toBe('chore');
  });
});

describe('kind backfill (agent_tickets_backfill_kind_bug)', () => {
  it('matches the word bug / bugfix / bugfixes, not "bugs" or "debug"', () => {
    for (const t of [
      '[bugfix] x',
      '[Bug] x',
      'ticket board - bug -sortie',
      'Bugfix regarding scroll',
      'Misc Minor Bugfixes',
    ]) {
      expect(BUG_TITLE.test(t)).toBe(true);
    }
    expect(BUG_TITLE.test('Add a debug panel')).toBe(false);
    expect(BUG_TITLE.test('Velocity — bugs filed vs fixed per week')).toBe(false);
  });

  it('tags bug-titled non-Epic tickets once, and never overwrites a classification', () => {
    const bug = createTicket(db, { title: '[bugfix] broken thing', projectId: pd });
    const epic = createTicket(db, { title: 'Misc Minor Bugfixes', projectId: pd, isEpic: true });
    const feature = createTicket(db, { title: 'Add debug panel', projectId: pd });
    const classified = createTicket(db, {
      title: 'bug-looking chore',
      projectId: pd,
      kind: 'chore',
    });
    // Re-run the migration as a deploy onto an existing DB would.
    db.prepare(`DELETE FROM _migrations WHERE id = 'agent_tickets_backfill_kind_bug'`).run();
    bootstrapSchema(db);
    expect(getTicket(db, bug.id)!.kind).toBe('bug');
    expect(getTicket(db, epic.id)!.kind).toBeNull();
    expect(getTicket(db, feature.id)!.kind).toBeNull();
    expect(getTicket(db, classified.id)!.kind).toBe('chore');
  });
});
