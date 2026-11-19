import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { REFINE_AUTOSTART_STATUS_KEY, type RefineAutostartStatus } from '@dashboard/shared';
import { ensureRobotStateTable, holdForSessionLimit, pauseDispatch, readStateNumber } from '../robot/state';
import { AUTOSTART_SINCE_KEY, backfillRemaining, openSessionCount, runAutostart } from './autostart';

// The columns the scheduler reads, as named in the server's canonical schema (the worker never
// imports it — same convention as refine.spec.ts).
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT,
      status TEXT NOT NULL DEFAULT 'backlog', refined INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER, created_at INTEGER NOT NULL,
      priority TEXT NOT NULL DEFAULT 'none', is_epic INTEGER NOT NULL DEFAULT 0, epic_id INTEGER
    );
    CREATE TABLE agent_ticket_events (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL,
      detail TEXT, created_at INTEGER NOT NULL
    );
  `);
  ensureRobotStateTable(db);
  return db;
}

const ON = { enabled: true, openCap: 2 };
let db: Database.Database;
let nextId = 1;

function ticket(
  createdAt: number,
  over: Partial<{ status: string; refined: number; archived_at: number | null; title: string; priority: string; is_epic: number; epic_id: number | null }> = {},
): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO agent_tickets (id, display_id, title, body, status, refined, archived_at, created_at, priority, is_epic, epic_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `PD-${id}`,
    over.title ?? `t${id}`,
    'the body',
    over.status ?? 'backlog',
    over.refined ?? 0,
    over.archived_at ?? null,
    createdAt,
    over.priority ?? 'none',
    over.is_epic ?? 0,
    over.epic_id ?? null,
  );
  return id;
}
function event(ticketId: number, type: string, at: number, detail: unknown = { text: type }): void {
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    type,
    JSON.stringify(detail),
    at,
  );
}
const kickoffs = (id: number) =>
  db.prepare("SELECT detail FROM agent_ticket_events WHERE ticket_id = ? AND type = 'refine_human'").all(id) as { detail: string }[];
const status = () => {
  const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(REFINE_AUTOSTART_STATUS_KEY) as { value: string };
  return JSON.parse(row.value) as RefineAutostartStatus;
};

beforeEach(() => {
  db = freshDb();
  nextId = 1;
});

describe('Refine auto-start (PD-747, D-096)', () => {
  it('does nothing while switched off, and says so', () => {
    ticket(2000);
    expect(runAutostart(db, { enabled: false, openCap: 15 }, 1000)).toBeNull();
    expect(status()).toMatchObject({ enabled: false, heldBy: expect.stringContaining('off') });
    expect(readStateNumber(db, AUTOSTART_SINCE_KEY)).toBe(0); // the boundary is not set until enabled
  });

  it('starts new tickets oldest first, one per cycle, ahead of anything older (PD-748 backfill)', () => {
    const cap = { enabled: true, openCap: 15 };
    const before = ticket(500); // predates the boundary — backfill material
    expect(runAutostart(db, cap, 1000)).toBe(before); // nothing new yet, so the backfill runs
    const a = ticket(1100);
    const b = ticket(1200);
    const older = ticket(400); // another backfill candidate, created "earlier"
    expect(runAutostart(db, cap, 1300)).toBe(a);
    expect(runAutostart(db, cap, 1400)).toBe(b);
    expect(runAutostart(db, cap, 1500)).toBe(older); // only once the new ones are started
    const detail = JSON.parse(kickoffs(a)[0].detail) as { text: string; auto: boolean };
    expect(detail).toEqual({ text: 't2\n\nthe body', auto: true });
  });

  it('skips tickets that are refined, terminal, queued, archived, or already had a session', () => {
    runAutostart(db, ON, 1000);
    ticket(1100, { refined: 1 });
    ticket(1100, { status: 'closed' });
    ticket(1100, { status: 'queue' });
    ticket(1100, { archived_at: 1150 });
    const parked = ticket(1100);
    event(parked, 'refine_human', 1110);
    event(parked, 'refine_parked', 1120);
    expect(runAutostart(db, { enabled: true, openCap: 15 }, 1300)).toBeNull();
    expect(status().queued).toBe(0);
  });

  it('holds at the cap, counting sessions the agent is still working on, and frees a slot on commit or park', () => {
    runAutostart(db, ON, 1000);
    const waiting = ticket(1100);
    event(waiting, 'refine_human', 1110);
    event(waiting, 'refine_agent', 1120); // waiting on Steve
    const working = ticket(1100);
    event(working, 'refine_human', 1130); // the agent is working
    const fresh = ticket(1200);
    expect(openSessionCount(db)).toBe(2);
    expect(runAutostart(db, ON, 1300)).toBeNull();
    expect(status()).toMatchObject({ open: 2, cap: 2, queued: 1, heldBy: expect.stringContaining('at the cap') });
    event(waiting, 'refine_committed', 1400);
    expect(runAutostart(db, ON, 1500)).toBe(fresh);
  });

  it('honours the session-limit hold and a paused Robot loop', () => {
    runAutostart(db, ON, 1000);
    ticket(1100);
    holdForSessionLimit(db, 5000, 'limit', 1200);
    expect(runAutostart(db, ON, 1300)).toBeNull();
    expect(status().heldBy).toBe('provider session limit');

    const db2 = freshDb();
    db = db2;
    runAutostart(db, ON, 1000);
    ticket(1100);
    pauseDispatch(db, 'budget ceiling', 1200);
    expect(runAutostart(db, ON, 1300)).toBeNull();
    expect(status().heldBy).toContain('paused');
  });

  it('never moves the boundary once set', () => {
    runAutostart(db, ON, 1000);
    runAutostart(db, ON, 9000);
    expect(readStateNumber(db, AUTOSTART_SINCE_KEY)).toBe(1000);
  });
});

describe('Refine backlog backfill (PD-748, D-096 §3)', () => {
  const BIG = { enabled: true, openCap: 50 };
  const excluded = (id: number, value: boolean, at: number) => event(id, 'refine_backfill_excluded', at, { excluded: value });

  it('drips older tickets in after new ones, highest priority first, then oldest', () => {
    const p3 = ticket(100, { priority: 'P3' });
    const p1old = ticket(200, { priority: 'P1' });
    const p1new = ticket(300, { priority: 'P1' });
    const unset = ticket(50);
    runAutostart(db, BIG, 1000); // boundary at 1000 — but nothing new, so the backfill starts at once
    const fresh = ticket(1100);
    const order = [runAutostart(db, BIG, 1200), runAutostart(db, BIG, 1300), runAutostart(db, BIG, 1400), runAutostart(db, BIG, 1500)];
    // The first cycle (at 1000) already took the top backfill item, p1old.
    expect(kickoffs(p1old)).toHaveLength(1);
    expect(order).toEqual([fresh, p1new, p3, unset]);
  });

  it('refines an Epic before its members, then frees the members once the Epic is refined or its session ends', () => {
    const epic = ticket(100, { is_epic: 1, priority: 'P2' });
    const m1 = ticket(110, { priority: 'P2', epic_id: epic });
    const m2 = ticket(120, { priority: 'P2', epic_id: epic });
    expect(runAutostart(db, BIG, 1000)).toBe(epic);
    // The Epic's session is open: its members wait for the Populate.
    expect(runAutostart(db, BIG, 1100)).toBeNull();
    event(epic, 'refine_parked', 1150); // the session ended without refining the Epic
    expect(runAutostart(db, BIG, 1200)).toBe(m1);
    expect(runAutostart(db, BIG, 1300)).toBe(m2);
  });

  it('members of a refined Epic are candidates on their own', () => {
    const epic = ticket(100, { is_epic: 1, refined: 1 });
    const m = ticket(110, { epic_id: epic });
    expect(runAutostart(db, BIG, 1000)).toBe(m);
  });

  it('an excluded Epic and its members are never picked; re-including brings them back', () => {
    const epic = ticket(100, { is_epic: 1, priority: 'P4' });
    const m = ticket(110, { priority: 'P4', epic_id: epic });
    excluded(epic, true, 120);
    expect(runAutostart(db, BIG, 1000)).toBeNull();
    expect(backfillRemaining(db, 1000)).toBe(0);
    excluded(epic, false, 1050);
    expect(runAutostart(db, BIG, 1100)).toBe(epic);
    expect(kickoffs(m)).toHaveLength(0);
  });

  it('publishes how much backlog remains, and never counts below zero', () => {
    ticket(100);
    ticket(200);
    runAutostart(db, BIG, 1000);
    expect(status()).toMatchObject({ backfillRemaining: 1, queued: 0 });
    runAutostart(db, BIG, 1100);
    expect(status()).toMatchObject({ backfillRemaining: 0, queued: 0 });
  });
});
