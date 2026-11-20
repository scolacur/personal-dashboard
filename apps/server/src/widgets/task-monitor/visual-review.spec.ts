import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureStateFor, listAwaitingVisual, recordVisualReview } from './visual-review';

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

describe('capture state on the awaiting list (PD-794)', () => {
  const MIN = 60_000;
  const NOW = 1_000_000;
  const worker = () =>
    db.exec(`
      CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE visual_captures (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    `);
  const beat = (value: '0' | '1', at: number) =>
    db.prepare("INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES ('visual_capture_enabled', ?, ?)").run(value, at);
  const capture = (outcome: string, detail: string | null, at: number, pr = 314) =>
    db.prepare("INSERT INTO visual_captures (ticket_id, pr_number, head_sha, outcome, detail, created_at) VALUES (1, ?, 'abc', ?, ?, ?)").run(pr, outcome, detail, at);
  const state = () => {
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 110);
    return listAwaitingVisual(db, NOW)[0].capture;
  };

  it('is unknown when the worker has never reported (its tables may not even exist)', () => {
    expect(state()).toEqual({ kind: 'unknown', lastSeen: null });
  });

  it('is off when the worker says capture is off', () => {
    worker();
    beat('0', NOW - MIN);
    expect(state()).toEqual({ kind: 'off' });
  });

  it("an 'off' row for the head still defers to the heartbeat", () => {
    worker();
    beat('0', NOW - MIN);
    capture('off', 'VISUAL_CAPTURE_ENABLED unset', 150);
    expect(state()).toEqual({ kind: 'off' });
  });

  it('is capturing, since the head arrived, when capture is on and the head has no row', () => {
    worker();
    beat('1', NOW - MIN);
    capture('captured', '/dir', 50); // an older head, before this hand-off
    expect(state()).toEqual({ kind: 'capturing', since: 100 });
  });

  it('is unknown when the heartbeat is stale, rather than claiming capture is running', () => {
    worker();
    beat('1', NOW - 11 * MIN);
    expect(state()).toEqual({ kind: 'unknown', lastSeen: NOW - 11 * MIN });
  });

  it("reports the head's capture outcome: captured, failed with its reason, skipped with why", () => {
    worker();
    beat('1', NOW - MIN);
    capture('failed', 'vite build exited 1', 150);
    expect(captureStateFor(db, 314, 100, NOW)).toEqual({ kind: 'failed', reason: 'vite build exited 1' });
    capture('skipped', 'no web changes', 160);
    expect(captureStateFor(db, 314, 100, NOW)).toEqual({ kind: 'skipped', reason: 'no web changes' });
    capture('captured', '/dir', 170);
    expect(captureStateFor(db, 314, 100, NOW)).toEqual({ kind: 'captured' });
    // Another PR's row never counts.
    capture('failed', 'x', 180, 999);
    expect(captureStateFor(db, 314, 100, NOW)).toEqual({ kind: 'captured' });
  });
});
