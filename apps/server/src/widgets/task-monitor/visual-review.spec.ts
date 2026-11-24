import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoMergeOn, captureStateFor, evaluatorShipped, listAwaitingVisual, recordVisualReview } from './visual-review';

let db: Database.Database;
const event = (type: string, detail: object, at: number, ticket = 1) =>
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(ticket, type, JSON.stringify(detail), at);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, status TEXT NOT NULL DEFAULT 'queue', project_id INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, github_repo TEXT);
    INSERT INTO agent_projects (id, github_repo) VALUES (1, 'x/y');
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, assignee, agent_state, archived_at) VALUES (1, 'PD-1', 'Calendar', 'robot', 'in-review', NULL)").run();
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

describe('visual review on session PRs (PD-915)', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, assignee) VALUES (2, 'PD-2', 'Session work', 'steve')").run();
  });

  it('lists a session PR from its latest review, and an approval after that review clears it', () => {
    event('robot_evaluating', { prNumber: 500, round: 1, lens: 'code' }, 100, 2);
    event('robot_visual_review_requested', { prNumber: 500, by: 'evaluator', reason: 'new layout' }, 110, 2);
    const [item] = listAwaitingVisual(db).filter((i) => i.ticketId === 2);
    expect(item).toMatchObject({ displayId: 'PD-2', prNumber: 500, prUrl: 'https://github.com/x/y/pull/500', reasons: [{ by: 'evaluator', reason: 'new layout' }] });
    expect(recordVisualReview(db, 2, true, '', 200)).toMatchObject({ ok: true });
    expect(listAwaitingVisual(db).filter((i) => i.ticketId === 2)).toEqual([]);
  });

  it('asks again after a new push is reviewed', () => {
    event('robot_evaluating', { prNumber: 500, round: 1, lens: 'code' }, 100, 2);
    event('robot_visual_review_requested', { prNumber: 500, by: 'evaluator', reason: 'x' }, 110, 2);
    recordVisualReview(db, 2, true, '', 120);
    event('robot_evaluating', { prNumber: 500, round: 2, lens: 'code' }, 130, 2);
    expect(listAwaitingVisual(db).filter((i) => i.ticketId === 2)).toHaveLength(1);
  });

  it('drops it once the ticket is completed, or while the Robot holds the ticket', () => {
    event('robot_evaluating', { prNumber: 500, round: 1, lens: 'code' }, 100, 2);
    event('robot_visual_review_requested', { prNumber: 500, by: 'evaluator', reason: 'x' }, 110, 2);
    db.exec("UPDATE agent_tickets SET status = 'completed' WHERE id = 2");
    expect(listAwaitingVisual(db).filter((i) => i.ticketId === 2)).toEqual([]);
    db.exec("UPDATE agent_tickets SET status = 'queue', assignee = 'robot', agent_state = 'working' WHERE id = 2");
    expect(listAwaitingVisual(db).filter((i) => i.ticketId === 2)).toEqual([]);
  });
});

describe('auto-merge switch mirror (PD-795)', () => {
  it('reads AUTO_MERGE_ROBOT for robot PRs and AUTO_MERGE_ALL for the rest, exactly "on"', () => {
    expect(autoMergeOn(true, { AUTO_MERGE_ROBOT: 'on' })).toBe(true);
    expect(autoMergeOn(true, { AUTO_MERGE_ROBOT: 'off' })).toBe(false);
    expect(autoMergeOn(true, { AUTO_MERGE_ROBOT: 'true' })).toBe(false); // only exactly "on"
    expect(autoMergeOn(true, {})).toBe(false);
    expect(autoMergeOn(false, { AUTO_MERGE_ALL: 'on' })).toBe(true);
    expect(autoMergeOn(false, { AUTO_MERGE_ROBOT: 'on' })).toBe(false); // the robot switch does not cover non-robot PRs
  });
});

describe('evaluator ship for the current head (PD-795)', () => {
  const ev = (type: string, detail: object, at: number, id: number) => ({ id, ticket_id: 1, type, detail: JSON.stringify(detail), created_at: at });

  it('is a ship only when the latest verdict on every lens after the boundary is ship', () => {
    const events = [
      ev('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'ship' }, 200, 1),
      ev('robot_evaluated', { prNumber: 314, lens: 'security', verdict: 'ship' }, 210, 2),
    ];
    expect(evaluatorShipped(events, 314, 100)).toBe(true);
  });

  it('is false when any lens revises', () => {
    const events = [
      ev('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'ship' }, 200, 1),
      ev('robot_evaluated', { prNumber: 314, lens: 'security', verdict: 'revise' }, 210, 2),
    ];
    expect(evaluatorShipped(events, 314, 100)).toBe(false);
  });

  it('takes the latest verdict per lens (a later ship overrides an earlier revise)', () => {
    const events = [
      ev('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'revise' }, 200, 1),
      ev('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'ship' }, 220, 2),
    ];
    expect(evaluatorShipped(events, 314, 100)).toBe(true);
  });

  it('ignores verdicts at or before the boundary, and for other PRs', () => {
    const events = [
      ev('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'ship' }, 100, 1), // at boundary
      ev('robot_evaluated', { prNumber: 999, lens: 'code', verdict: 'ship' }, 200, 2), // other PR
    ];
    expect(evaluatorShipped(events, 314, 100)).toBe(false);
  });

  it('is false when the Evaluator has produced no verdict for this head', () => {
    expect(evaluatorShipped([], 314, 100)).toBe(false);
  });
});

describe('mergesOnApprove on the awaiting list (PD-795)', () => {
  afterEach(() => {
    delete process.env.AUTO_MERGE_ROBOT;
    delete process.env.AUTO_MERGE_ALL;
  });

  it('is true for a shipped robot PR when AUTO_MERGE_ROBOT is on', () => {
    process.env.AUTO_MERGE_ROBOT = 'on';
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 110);
    event('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'ship' }, 120);
    expect(listAwaitingVisual(db)[0].mergesOnApprove).toBe(true);
  });

  it('is false when the switch is off, even if shipped', () => {
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 110);
    event('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'ship' }, 120);
    expect(listAwaitingVisual(db)[0].mergesOnApprove).toBe(false);
  });

  it('is false when the switch is on but there is no ship verdict', () => {
    process.env.AUTO_MERGE_ROBOT = 'on';
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 110);
    event('robot_evaluated', { prNumber: 314, lens: 'code', verdict: 'revise' }, 120);
    expect(listAwaitingVisual(db)[0].mergesOnApprove).toBe(false);
  });
});
