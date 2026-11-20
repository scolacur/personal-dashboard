import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { listAwaitingVisual, recordVisualReview } from './visual-review';

let db: Database.Database;
const event = (type: string, detail: object, at: number, ticket = 1) =>
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(ticket, type, JSON.stringify(detail), at);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO agent_tickets VALUES (1, 'PD-1', 'Calendar', 'robot', 'in-review', NULL)").run();
  event('robot_handoff', { prUrl: 'https://github.com/x/y/pull/314' }, 100);
});

describe('visual review, server side (PD-773)', () => {
  it('lists a requested PR with its newest capture, and records an approval that clears it', () => {
    expect(listAwaitingVisual(db)).toEqual([]);
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'New calendar' }, 110);
    event('robot_visual_captured', { prNumber: 314, shots: [{ route: '/h', viewport: 'desktop', scheme: 'light', file: 'a.png', url: '/u' }] }, 120);
    db.prepare("INSERT INTO agent_notifications (kind, ticket_id, title, created_at) VALUES ('agent_visual_review', 1, 't', 1)").run();
    const [item] = listAwaitingVisual(db);
    expect(item).toMatchObject({ displayId: 'PD-1', prNumber: 314, reasons: [{ by: 'robot', reason: 'New calendar' }], capturedAt: 120 });
    expect(item.shots).toHaveLength(1);

    expect(recordVisualReview(db, 1, true, '', 200)).toMatchObject({ ok: true });
    expect(listAwaitingVisual(db)).toEqual([]);
    expect((db.prepare('SELECT read_at FROM agent_notifications').get() as { read_at: number }).read_at).toBe(200);
    expect(recordVisualReview(db, 1, true, '', 300)).toEqual({ ok: false, reason: 'not_waiting' });
  });

  it('asks again after a new hand-off of the same PR, and ignores requests for other PRs', () => {
    event('robot_visual_review_requested', { prNumber: 999, by: 'robot', reason: 'old PR' }, 110);
    expect(listAwaitingVisual(db)).toEqual([]);
    event('robot_visual_review_requested', { prNumber: 314, by: 'evaluator', reason: 'layout' }, 120);
    recordVisualReview(db, 1, false, 'fix header', 130);
    expect(listAwaitingVisual(db)).toEqual([]);
    event('robot_handoff', { prUrl: 'https://github.com/x/y/pull/314' }, 200);
    expect(listAwaitingVisual(db)).toHaveLength(1);
  });

  it('refuses unknown tickets', () => {
    expect(recordVisualReview(db, 42, true, '')).toEqual({ ok: false, reason: 'not_found' });
  });
});
