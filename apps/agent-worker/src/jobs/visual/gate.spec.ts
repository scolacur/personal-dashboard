import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorkerConfig } from '../../shared/config';
import { loadConfig } from '../../shared/config';
import { ensureRunsTable, finishRun, startRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import { ensureEvaluatorRunsTable } from '../evaluate/evaluator-runs';
import { evaluateOnePr, reviewBoundary } from '../evaluate/evaluate';
import type { EvaluatorTurnResult } from '../evaluate/evaluate-agent';
import { pendingEvaluatorBrief } from '../evaluate/brief';
import { visualGate, VISUAL_PENDING_DESCRIPTION } from './gate';
import { releaseVisualDecisions } from './release';

/**
 * The visual-review gate end to end on the worker side (PD-773 slice 2): a flag holds an Evaluator
 * ship at pending, Steve's approval releases it once, his rejection re-queues with his note.
 */

const SHA = 'a'.repeat(40);
const TARGET = { ticketId: 1, repo: 'scolacur/personal-dashboard', prNumber: 314 };
const ship = '{"verdict":"ship","summary":"Good.","findings":[]}';
const shipAskingVisual = '{"verdict":"ship","summary":"New page.","findings":[],"visualReview":"New Habits calendar layout"}';

function config(): AgentWorkerConfig {
  const base = loadConfig({});
  return { ...base, evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, securityEnabled: false, allPrs: false, reviewGateToken: 'tok' } };
}
const agent = (text: string) => vi.fn(async (): Promise<EvaluatorTurnResult> => ({ text, ok: true, turns: 2, tokens: 10 }));

let db: Database.Database;
let posts: { state: string; description: string }[];
const deps = () => ({
  fetchHeadSha: async () => SHA,
  postStatus: async (_r: string, _s: string, st: { state: string; description: string }) => (posts.push(st), true),
  fetchDiff: async () => 'diff',
});
const event = (type: string, detail: object, at: number) =>
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (1, ?, ?, ?)').run(type, JSON.stringify(detail), at);
const state = () => (db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = 1').get() as { s: string }).s;

beforeEach(() => {
  posts = [];
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  ensureRunsTable(db);
  ensureRobotStateTable(db);
  ensureEvaluatorRunsTable(db);
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, body, status, assignee, agent_state) VALUES (1, 'PD-1', 'Calendar', '## Done When\n- x', 'queue', 'robot', 'in-review')").run();
  finishRun(db, startRun(db, { ticketId: 1, issueNumber: null, branch: 'robot/t1' }, 10), { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 100);
});

describe('visual-review gate (PD-773)', () => {
  it('without a request, a ship is a plain success', async () => {
    await evaluateOnePr(db, config(), TARGET, { ...deps(), runAgent: agent(ship) }, 200);
    expect(posts.at(-1)?.state).toBe('success');
  });

  it("the Evaluator's own request holds its ship at pending and notifies Steve", async () => {
    await evaluateOnePr(db, config(), TARGET, { ...deps(), runAgent: agent(shipAskingVisual) }, 200);
    expect(posts.at(-1)).toEqual({ state: 'pending', description: VISUAL_PENDING_DESCRIPTION });
    expect(visualGate(db, 1, 314, reviewBoundary(db, 1))).toBe('pending');
    const n = db.prepare("SELECT title FROM agent_notifications WHERE kind = 'agent_visual_review'").get() as { title: string };
    expect(n.title).toMatch(/^Visual check waiting: PR #314 \(PD-1\)/);
  });

  it('a Robot request for another PR does not hold this one', async () => {
    event('robot_visual_review_requested', { prNumber: 999, by: 'robot', reason: 'x' }, 150);
    await evaluateOnePr(db, config(), TARGET, { ...deps(), runAgent: agent(ship) }, 200);
    expect(posts.at(-1)?.state).toBe('success');
  });

  it("Steve's approval releases the held success exactly once", async () => {
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 150);
    await evaluateOnePr(db, config(), TARGET, { ...deps(), runAgent: agent(ship) }, 200);
    expect(posts.at(-1)?.state).toBe('pending');
    event('robot_visual_reviewed', { prNumber: 314, approved: true }, 300);
    posts = [];
    const d = { boundary: reviewBoundary, ...deps() };
    expect(await releaseVisualDecisions(db, config(), 400, d)).toBe(1);
    expect(posts).toEqual([{ state: 'success', description: "Evaluator: ship; Steve's visual check: approved" }]);
    expect(await releaseVisualDecisions(db, config(), 500, d)).toBe(0);
  });

  it('an approval waits for the Evaluator to ship before releasing anything', async () => {
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 150);
    event('robot_visual_reviewed', { prNumber: 314, approved: true }, 160);
    expect(await releaseVisualDecisions(db, config(), 400, { boundary: reviewBoundary, ...deps() })).toBe(0);
    // The Evaluator's own ship then posts success directly: the approval already stands.
    await evaluateOnePr(db, config(), TARGET, { ...deps(), runAgent: agent(ship) }, 500);
    expect(posts.at(-1)?.state).toBe('success');
  });

  it("a rejection re-queues the Robot once, and its note is in the next run's brief", async () => {
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 150);
    event('robot_dispatched', {}, 50);
    event('robot_visual_reviewed', { prNumber: 314, approved: false, note: 'The header wraps on phone.' }, 300);
    expect(await releaseVisualDecisions(db, config(), 400, { boundary: reviewBoundary, ...deps() })).toBe(1);
    expect(state()).toBe('queued');
    expect(pendingEvaluatorBrief(db, 1)).toMatch(/visual check: changes requested[\s\S]*The header wraps on phone\./);
    db.prepare("UPDATE agent_tickets SET agent_state = 'in-review' WHERE id = 1").run();
    expect(await releaseVisualDecisions(db, config(), 500, { boundary: reviewBoundary, ...deps() })).toBe(0);
  });

  it('a decision on an older head does not carry past a new hand-off', () => {
    event('robot_visual_review_requested', { prNumber: 314, by: 'robot', reason: 'look' }, 50);
    event('robot_visual_reviewed', { prNumber: 314, approved: true }, 60);
    expect(visualGate(db, 1, 314, reviewBoundary(db, 1))).toBe('pending'); // boundary = hand-off at 100
  });
});
