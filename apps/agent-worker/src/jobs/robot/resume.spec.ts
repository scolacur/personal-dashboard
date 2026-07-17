import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import { askHumanResume, resumeAskHuman, ticketsAwaitingHuman } from './resume';

function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, title TEXT, body TEXT, status TEXT NOT NULL,
      agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
  `);
  return d;
}

function parked(d: Database.Database, id: number, state = 'awaiting-human'): void {
  d.prepare("INSERT INTO agent_tickets (id, status, agent_state) VALUES (?, 'robot_queue', ?)").run(id, state);
}
function ev(d: Database.Database, id: number, type: string, detail: unknown, at: number): void {
  d.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(id, type, JSON.stringify(detail), at);
}
function state(d: Database.Database, id: number): string | null {
  return (d.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = ?').get(id) as { s: string | null }).s;
}

describe('askHumanResume', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
    parked(d, 1);
  });

  it('is null with no human reply', () => {
    ev(d, 1, ROBOT_EVENT.dispatched, {}, 100);
    ev(d, 1, ROBOT_EVENT.askHuman, { question: 'A or B?' }, 200);
    expect(askHumanResume(d, 1)).toBeNull();
  });

  it('returns the question + answer when a reply post-dates the question and the last dispatch', () => {
    ev(d, 1, ROBOT_EVENT.dispatched, {}, 100);
    ev(d, 1, ROBOT_EVENT.askHuman, { question: 'A or B?' }, 200);
    ev(d, 1, ROBOT_EVENT.humanReply, { text: 'Go with B.' }, 300);
    expect(askHumanResume(d, 1)).toEqual({ question: 'A or B?', answer: 'Go with B.' });
  });

  it('is null for a stale reply that predates the current question', () => {
    ev(d, 1, ROBOT_EVENT.humanReply, { text: 'old answer' }, 150);
    ev(d, 1, ROBOT_EVENT.askHuman, { question: 'new question?' }, 200);
    expect(askHumanResume(d, 1)).toBeNull();
  });

  it('is null once a later dispatch has already consumed the answer (no re-injection into rework)', () => {
    ev(d, 1, ROBOT_EVENT.askHuman, { question: 'A or B?' }, 100);
    ev(d, 1, ROBOT_EVENT.humanReply, { text: 'B.' }, 200);
    ev(d, 1, ROBOT_EVENT.dispatched, {}, 300); // resume dispatch consumed the answer
    expect(askHumanResume(d, 1)).toBeNull();
  });
});

describe('resumeAskHuman sweep', () => {
  it('re-queues every awaiting-human ticket whose answer has landed, and logs robot_resumed', () => {
    const d = db();
    parked(d, 1); // has an answer → resumes
    ev(d, 1, ROBOT_EVENT.askHuman, { question: 'q1' }, 100);
    ev(d, 1, ROBOT_EVENT.humanReply, { text: 'a1' }, 200);
    parked(d, 2); // still waiting, no reply → stays parked
    ev(d, 2, ROBOT_EVENT.askHuman, { question: 'q2' }, 100);

    expect(ticketsAwaitingHuman(d).sort()).toEqual([1, 2]);
    const resumed = resumeAskHuman(d, 1000);
    expect(resumed).toBe(1);
    expect(state(d, 1)).toBe('queued');
    expect(state(d, 2)).toBe('awaiting-human');

    const types = (d.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1 ORDER BY id').all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain('robot_resumed');
  });
});
