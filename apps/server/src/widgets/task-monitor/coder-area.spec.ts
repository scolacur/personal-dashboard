import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  approveRefine,
  createTicket,
  getProjectBySlug,
  getTicket,
  listTickets,
  updateTicket,
  ValidationError,
} from './store';
import { effectiveCoderArea, DEFAULT_CODER_AREA } from '@dashboard/shared';
import type { CoderArea } from '@dashboard/shared';

/** PD-880 — Coder code-area subtype: resolution, storage, validation, and Refine assignment. */

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

describe('effectiveCoderArea resolution (PD-880)', () => {
  it('resolves the ticket override first, then the Epic, then general', () => {
    expect(effectiveCoderArea({ coderArea: 'board' }, { coderArea: 'loop' })).toBe('board');
    expect(effectiveCoderArea({ coderArea: null }, { coderArea: 'loop' })).toBe('loop');
    expect(effectiveCoderArea({ coderArea: null }, { coderArea: null })).toBe('general');
    expect(effectiveCoderArea({ coderArea: null }, null)).toBe(DEFAULT_CODER_AREA);
    expect(effectiveCoderArea({}, {})).toBe('general'); // undefined treated as unset
  });
});

describe('coder_area storage + validation', () => {
  it('defaults to null, and is set / changed / cleared through create and update', () => {
    expect(createTicket(db, { title: 'x', projectId: pd }).coderArea).toBeNull();
    const t = createTicket(db, { title: 'y', projectId: pd, coderArea: 'loop' });
    expect(getTicket(db, t.id)!.coderArea).toBe('loop');
    expect(updateTicket(db, t.id, { coderArea: 'board' })!.coderArea).toBe('board');
    expect(updateTicket(db, t.id, { title: 'renamed' })!.coderArea).toBe('board'); // omitted = unchanged
    expect(updateTicket(db, t.id, { coderArea: null })!.coderArea).toBeNull();
  });

  it('rejects an area outside the registry on create and update', () => {
    expect(() =>
      createTicket(db, { title: 'x', projectId: pd, coderArea: 'frontend' as CoderArea }),
    ).toThrow(ValidationError);
    const t = createTicket(db, { title: 'x', projectId: pd });
    expect(() => updateTicket(db, t.id, { coderArea: 'Loop' as CoderArea })).toThrow(
      ValidationError,
    );
  });
});

describe('Refine assignment of coder_area', () => {
  it('refine_in_place sets the area; omitting it leaves the ticket alone', () => {
    const kept = createTicket(db, { title: 'x', projectId: pd, coderArea: 'metrics' });
    seedProposal(db, kept.id, { mode: 'refine_in_place', body: ROBOT_BODY });
    expect(approveRefine(db, kept.id).ok).toBe(true);
    expect(getTicket(db, kept.id)!.coderArea).toBe('metrics');

    const set = createTicket(db, { title: 'y', projectId: pd });
    seedProposal(db, set.id, { mode: 'refine_in_place', body: ROBOT_BODY, coderArea: 'loop' });
    expect(approveRefine(db, set.id).ok).toBe(true);
    expect(getTicket(db, set.id)!.coderArea).toBe('loop');
  });

  it('a Populate sets the Epic default; a child stores its own only when it overrides', () => {
    const epic = createTicket(db, { title: 'An epic', projectId: pd, isEpic: true });
    seedProposal(db, epic.id, {
      mode: 'populate',
      body: 'rewritten epic description',
      coderArea: 'loop',
      children: [
        { title: 'inherits', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' },
        {
          title: 'overrides',
          body: ROBOT_BODY,
          status: 'backlog',
          assignee: 'robot',
          coderArea: 'board',
        },
      ],
    });
    expect(approveRefine(db, epic.id).ok).toBe(true);
    expect(getTicket(db, epic.id)!.coderArea).toBe('loop');

    const byTitle = Object.fromEntries(listTickets(db).map((t) => [t.title, t]));
    // The inheriting child stores nothing — it resolves to the Epic's area via effectiveCoderArea.
    expect(byTitle.inherits.coderArea).toBeNull();
    expect(effectiveCoderArea(byTitle.inherits, getTicket(db, epic.id))).toBe('loop');
    // The overriding child stores its own area.
    expect(byTitle.overrides.coderArea).toBe('board');
    expect(effectiveCoderArea(byTitle.overrides, getTicket(db, epic.id))).toBe('board');
  });
});
