import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROBOT_EVENT } from '@dashboard/shared';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureRunsTable } from '../robot/runs';
import { logMilestone } from '../robot/events';
import { ensureRobotStateTable } from '../robot/state';
import { releaseVisualDecisions } from '../visual/release';
import { ensureEvaluatorRunsTable } from './evaluator-runs';
import { evaluateNextOtherPr, type OtherPr } from './all-prs';
import { runAdoptionPass } from './adopt-pass';
import { completeMergedSessionTickets, type MergedPr } from './session-merges';
import type { StatusRead } from './review-gate';

const SHA = 'a'.repeat(40);
const MIN = 60_000;
const pr = (over: Partial<OtherPr> = {}): OtherPr => ({
  number: 500, title: 'feat', body: '', headRefName: 'pd-705-thing', headRefOid: SHA, baseRefName: 'main',
  isCrossRepository: false, isDraft: false, labels: [], files: [{ path: 'apps/web/src/a.ts' }], ...over,
});

function cfg(over: Partial<AgentWorkerConfig['evaluator']> = {}): AgentWorkerConfig {
  const base = loadConfig({ ROBOT_GITHUB_TOKEN: 'w', VISUAL_CAPTURE_ENABLED: '1' });
  return {
    ...base,
    evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, securityEnabled: false, reviewGateToken: 'tok', adopt: true, adoptIdleMs: 30 * MIN, ...over },
  };
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, robot_enabled INTEGER NOT NULL DEFAULT 1, github_repo TEXT);
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL DEFAULT 1, display_id TEXT, title TEXT NOT NULL, body TEXT,
      status TEXT NOT NULL DEFAULT 'queue', assignee TEXT, agent_state TEXT, archived_at INTEGER,
      refined INTEGER NOT NULL DEFAULT 1, ready INTEGER NOT NULL DEFAULT 1, ready_bypassed INTEGER NOT NULL DEFAULT 0,
      github_issue_number INTEGER, updated_at INTEGER
    );
    CREATE TABLE agent_ticket_relations (id INTEGER PRIMARY KEY, from_ticket_id INTEGER, to_ticket_id INTEGER, type TEXT);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  ensureEvaluatorRunsTable(db);
  ensureRunsTable(db);
  ensureRobotStateTable(db);
  db.prepare("INSERT INTO agent_projects (id, github_repo) VALUES (1, 'scolacur/personal-dashboard')").run();
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, body, assignee) VALUES (705, 'PD-705', 'Do the thing', '## Done When\n- it works', 'steve')").run();
});

const ship = JSON.stringify({ verdict: 'ship', summary: 'Good.', findings: [], visualReview: 'the new layout' });

/** One session-path review at `now` that ships and asks for Steve's eyes; returns the statuses posted. */
async function reviewShip(now: number) {
  const statuses: string[] = [];
  const comments: string[] = [];
  await evaluateNextOtherPr(db, cfg(), now, {
    listPrs: async () => [pr()],
    fetchHeadSha: async () => SHA,
    fetchDiff: async () => 'diff',
    buildContext: () => 'ctx',
    runAgent: async () => ({ text: ship, ok: true, turns: 1, tokens: 1 }),
    comment: async (_r, _n, b) => void comments.push(b),
    postStatus: async (_r, _s, st) => (statuses.push(st.description), true),
    readStatus: async (): Promise<StatusRead> => ({ ok: true, current: null }),
  });
  return { statuses, comments };
}

const decide = (approved: boolean, at: number, note = '') =>
  logMilestone(db, 705, ROBOT_EVENT.visualReviewed, { prNumber: 500, approved, ...(note ? { note } : {}) }, at);

describe('visual gate on session PRs (PD-915)', () => {
  it('a ship the Evaluator flags waits for Steve, records the request on the branch ticket, and notifies', async () => {
    const h = await reviewShip(1000);
    expect(h.statuses.at(-1)).toBe("Waiting for Steve's visual check (Evaluator: ship)");
    expect(h.comments[0]).toContain("waits for Steve's visual check");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_ticket_events WHERE type = 'robot_visual_review_requested'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT kind FROM agent_notifications").all()).toEqual([{ kind: 'agent_visual_review' }]);
  });

  it('no branch ticket: no request, no hold', async () => {
    const statuses: string[] = [];
    await evaluateNextOtherPr(db, cfg(), 1000, {
      listPrs: async () => [pr({ headRefName: 'misc' })],
      fetchHeadSha: async () => SHA, fetchDiff: async () => 'diff', buildContext: () => 'ctx',
      runAgent: async () => ({ text: ship, ok: true, turns: 1, tokens: 1 }),
      comment: async () => undefined,
      postStatus: async (_r, _s, st) => (statuses.push(st.description), true),
      readStatus: async (): Promise<StatusRead> => ({ ok: true, current: null }),
    });
    expect(statuses.at(-1)).toBe('Evaluator: ship (round 1)');
  });

  it("Steve's approval after the review releases review-gate on the reviewed head, once", async () => {
    await reviewShip(1000);
    decide(true, 2000);
    const posted: { sha: string; d: string }[] = [];
    const deps = {
      boundary: () => 0,
      fetchHeadSha: async () => SHA,
      postStatus: async (_r: string, sha: string, st: { description: string }) => (posted.push({ sha, d: st.description }), true),
    };
    expect(await releaseVisualDecisions(db, cfg(), 3000, deps)).toBe(1);
    expect(posted).toEqual([{ sha: SHA, d: "Evaluator: ship; Steve's visual check: approved" }]);
    expect(await releaseVisualDecisions(db, cfg(), 4000, deps)).toBe(0);
  });

  it('an approval does not release a head pushed since the review', async () => {
    await reviewShip(1000);
    decide(true, 2000);
    const posted: string[] = [];
    await releaseVisualDecisions(db, cfg(), 3000, { boundary: () => 0, fetchHeadSha: async () => 'b'.repeat(40), postStatus: async (_r, sha) => (posted.push(sha), true) });
    expect(posted).toEqual([]);
  });

  it('a rejection is adopted by the Robot after the idle window, counted from the decision', async () => {
    await reviewShip(0);
    decide(false, 10 * MIN, 'header overlaps');
    const deps = { listPrs: async () => [pr()], comment: async () => undefined };
    expect((await runAdoptionPass(db, cfg(), 35 * MIN, deps)).adopted).toBe(0); // 25 min since the rejection
    expect((await runAdoptionPass(db, cfg(), 40 * MIN, deps)).adopted).toBe(1);
  });
});

describe('completeMergedSessionTickets (PD-915)', () => {
  const merged = (over: Partial<MergedPr> = {}): MergedPr => ({ number: 500, headRefName: 'pd-705-thing', baseRefName: 'main', mergedAt: new Date(5000).toISOString(), ...over });
  const status = () => (db.prepare('SELECT status FROM agent_tickets WHERE id = 705').get() as { status: string }).status;

  it('sets a watermark on the first pass, so nothing merged before it is swept up', async () => {
    expect(await completeMergedSessionTickets(db, cfg(), 10_000, { listMerged: async () => [merged()] })).toBe(0);
    expect(await completeMergedSessionTickets(db, cfg(), 20_000, { listMerged: async () => [merged()] })).toBe(0);
    expect(status()).toBe('queue');
  });

  it('completes the branch ticket of a session PR merged after the watermark, once', async () => {
    await completeMergedSessionTickets(db, cfg(), 1000, { listMerged: async () => [] });
    expect(await completeMergedSessionTickets(db, cfg(), 9000, { listMerged: async () => [merged()] })).toBe(1);
    expect(status()).toBe('completed');
    const ev = db.prepare("SELECT detail FROM agent_ticket_events WHERE type = 'robot_completed'").get() as { detail: string };
    expect(JSON.parse(ev.detail)).toEqual({ prNumber: 500, via: 'session_pr_merged' });
    db.exec("UPDATE agent_tickets SET status = 'queue' WHERE id = 705"); // Steve reopens it
    expect(await completeMergedSessionTickets(db, cfg(), 10_000, { listMerged: async () => [merged()] })).toBe(0);
    expect(status()).toBe('queue');
  });

  it('ignores robot/* PRs, PRs into other bases, branches naming no ticket, and terminal tickets', async () => {
    await completeMergedSessionTickets(db, cfg(), 1000, { listMerged: async () => [] });
    const list = [
      merged({ number: 1, headRefName: 'robot/t705' }),
      merged({ number: 2, baseRefName: 'dev' }),
      merged({ number: 3, headRefName: 'misc', title: 'PD-705' } as Partial<MergedPr>),
    ];
    expect(await completeMergedSessionTickets(db, cfg(), 9000, { listMerged: async () => list })).toBe(0);
    db.exec("UPDATE agent_tickets SET status = 'closed' WHERE id = 705");
    expect(await completeMergedSessionTickets(db, cfg(), 9500, { listMerged: async () => [merged({ number: 4 })] })).toBe(0);
    expect(status()).toBe('closed');
  });
});
