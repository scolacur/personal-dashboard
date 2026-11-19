import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { REFINE_AUTOSTART_STATUS_KEY, type RefineAutostartStatus } from '@dashboard/shared';
import { ensureRobotStateTable, holdForSessionLimit, pauseDispatch, readStateNumber } from '../robot/state';
import { AUTOSTART_SINCE_KEY, openSessionCount, runAutostart } from './autostart';

// The columns the scheduler reads, as named in the server's canonical schema (the worker never
// imports it — same convention as refine.spec.ts).
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT,
      status TEXT NOT NULL DEFAULT 'backlog', refined INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER, created_at INTEGER NOT NULL
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

function ticket(createdAt: number, over: Partial<{ status: string; refined: number; archived_at: number | null; title: string }> = {}): number {
  const id = nextId++;
  db.prepare(
    'INSERT INTO agent_tickets (id, display_id, title, body, status, refined, archived_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `PD-${id}`, over.title ?? `t${id}`, 'the body', over.status ?? 'backlog', over.refined ?? 0, over.archived_at ?? null, createdAt);
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

  it('starts only tickets created after it was first enabled, oldest first, one per cycle', () => {
    const before = ticket(500); // predates the boundary — the backfill's job, not this one's
    expect(runAutostart(db, ON, 1000)).toBeNull(); // first enabled cycle sets the boundary at 1000
    const a = ticket(1100);
    const b = ticket(1200);
    expect(runAutostart(db, ON, 1300)).toBe(a);
    expect(runAutostart(db, ON, 1400)).toBe(b);
    expect(kickoffs(before)).toHaveLength(0);
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
