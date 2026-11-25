import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { EvaluatorLens, EvaluatorVerdict } from '@dashboard/shared';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureRunsTable, startRun, finishRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import { evaluateOnePr, reviewBoundary, runEvaluatePass } from './evaluate';
import type { EvaluatorTurnResult } from './evaluate-agent';
import { ensureEvaluatorRunsTable, finishEvaluatorRun, startEvaluatorRun } from './evaluator-runs';
import { reconcileReviewGates } from './reconcile';
import { STEVE_APPROVED_DESCRIPTION, type GateStatus, type StatusRead } from './review-gate';
import { VISUAL_PENDING_DESCRIPTION } from '../visual/gate';
import type { OtherPr } from './all-prs';

/**
 * PD-1005 (Reconcile a lost review-gate post): a lost final review-gate post is repaired, a moved head
 * is reviewed again, Steve's approval is never touched, and none of it waits on the Evaluator budget.
 */

const TARGET = { ticketId: 1, repo: 'scolacur/personal-dashboard', prNumber: 576 };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REVIEWING: GateStatus = { state: 'pending', description: 'Evaluator reviewing (round 1)' };
const shipReply = '{"verdict":"ship","summary":"Meets every Done When item.","findings":[]}';

function config(over: Partial<AgentWorkerConfig['evaluator']> = {}, visual = false): AgentWorkerConfig {
  const base = loadConfig({});
  return {
    ...base,
    visual: { ...base.visual, enabled: visual },
    evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, securityEnabled: true, allPrs: false, reviewGateToken: 'tok', ...over },
  };
}

let db: Database.Database;

function harness(opts: { head?: string | null; current?: GateStatus | null; readOk?: boolean; postOk?: boolean } = {}) {
  const posts: { sha: string; status: GateStatus }[] = [];
  const read: StatusRead = opts.readOk === false ? { ok: false } : { ok: true, current: opts.current ?? null };
  return {
    posts,
    deps: {
      fetchHeadSha: vi.fn(async () => (opts.head === undefined ? SHA_A : opts.head)),
      readStatus: vi.fn(async () => read),
      postStatus: vi.fn(async (_repo: string, sha: string, status: GateStatus) => {
        posts.push({ sha, status });
        return opts.postOk ?? true;
      }),
    },
  };
}

/** A settled lens run in the current cycle, as the Robot path records it. */
function seedRun(lens: EvaluatorLens, verdict: EvaluatorVerdict | null, headSha: string | null, at = 200, round = 1): void {
  const id = startEvaluatorRun(db, { ticketId: 1, prNumber: TARGET.prNumber, round, model: 'm', lens, headSha: headSha ?? undefined }, at);
  finishEvaluatorRun(
    db,
    id,
    verdict ? { report: { verdict, summary: 's', findings: [] }, turns: 4, tokens: 900 } : { error: 'agent error', turns: 4 },
    at + 1,
  );
}

function events(type: string): { detail: string }[] {
  return db.prepare('SELECT detail FROM agent_ticket_events WHERE ticket_id = 1 AND type = ?').all(type) as { detail: string }[];
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT, ticket_id INTEGER, title TEXT, body TEXT, created_at INTEGER, read_at INTEGER, resolved_at INTEGER);
  `);
  ensureRunsTable(db);
  ensureRobotStateTable(db);
  ensureEvaluatorRunsTable(db);
  db.prepare(
    "INSERT INTO agent_tickets (id, display_id, title, body, status, assignee, agent_state) VALUES (1, 'PD-1', 'Add a thing', '## Done When\\n- it works', 'queue', 'robot', 'in-review')",
  ).run();
  const runId = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/t1' }, 10);
  finishRun(db, runId, { status: 'handed-off', prUrl: `https://github.com/scolacur/personal-dashboard/pull/${TARGET.prNumber}` }, 100);
});

describe('Robot-path runs record the head they reviewed', () => {
  it('pins the head before the run rows, so evaluator_runs.head_sha is set on every lens', async () => {
    const h = harness();
    await evaluateOnePr(db, config(), TARGET, { ...h.deps, runAgent: async () => ({ text: shipReply, ok: true }), fetchDiff: async () => 'd' }, 200);
    const rows = db.prepare('SELECT lens, head_sha FROM evaluator_runs ORDER BY lens').all();
    expect(rows).toEqual([
      { lens: 'code', head_sha: SHA_A },
      { lens: 'security', head_sha: SHA_A },
    ]);
  });
});

describe('reconcileReviewGates — a lost post is repaired', () => {
  it('repairs a lost success post: a stale "Evaluator reviewing" becomes the ship (the PR #576 strand)', async () => {
    // The review itself: both lenses ship, but the final post fails and is swallowed.
    const postStatus = vi.fn(async (_r: string, _s: string, st: GateStatus) => st.state !== 'success');
    await evaluateOnePr(
      db,
      config(),
      TARGET,
      { fetchHeadSha: async () => SHA_A, postStatus, runAgent: async (): Promise<EvaluatorTurnResult> => ({ text: shipReply, ok: true }), fetchDiff: async () => 'd' },
      200,
    );
    expect(postStatus.mock.calls.map((c) => c[2].state)).toEqual(['pending', 'success']);

    const h = harness({ current: REVIEWING });
    expect(await reconcileReviewGates(db, config(), 300, h.deps)).toBe(1);
    expect(h.posts).toEqual([{ sha: SHA_A, status: { state: 'success', description: 'Evaluator: ship (round 1)' } }]);
  });

  it('posts the verdict when the head has no review-gate status at all', async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
    const h = harness({ current: null });
    await reconcileReviewGates(db, config(), 300, h.deps);
    expect(h.posts.map((p) => p.status.state)).toEqual(['success']);
  });

  it("repairs a lost visual-pending post: a ship waiting for Steve's visual check goes back to that hold", async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (1, ?, ?, 250)').run(
      'robot_visual_review_requested',
      JSON.stringify({ prNumber: TARGET.prNumber, by: 'evaluator' }),
    );
    const h = harness({ current: REVIEWING });
    await reconcileReviewGates(db, config({}, true), 300, h.deps);
    expect(h.posts).toEqual([{ sha: SHA_A, status: { state: 'pending', description: VISUAL_PENDING_DESCRIPTION } }]);
  });

  it('repairs an escalate as the "Needs Steve" failure, the same table the review uses', async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'escalate', SHA_A);
    const h = harness({ current: REVIEWING });
    await reconcileReviewGates(db, config(), 300, h.deps);
    expect(h.posts[0].status).toEqual({ state: 'failure', description: 'Needs Steve: the Evaluator escalated (round 1)' });
  });

  it('a failed repost is tried again on the next pass', async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
    const failing = harness({ current: REVIEWING, postOk: false });
    expect(await reconcileReviewGates(db, config(), 300, failing.deps)).toBe(0);
    const ok = harness({ current: REVIEWING });
    expect(await reconcileReviewGates(db, config(), 400, ok.deps)).toBe(1);
    expect(ok.posts).toHaveLength(1);
  });
});

describe('reconcileReviewGates — what it leaves alone', () => {
  beforeEach(() => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
  });

  it("never replaces Steve's approval (PD-914)", async () => {
    const h = harness({ current: { state: 'success', description: STEVE_APPROVED_DESCRIPTION } });
    expect(await reconcileReviewGates(db, config(), 300, h.deps)).toBe(0);
    expect(h.deps.postStatus).not.toHaveBeenCalled();
  });

  it('leaves a status that is already a verdict, and never writes over a success', async () => {
    for (const current of [
      { state: 'success', description: 'Evaluator: ship (round 1)' },
      { state: 'failure', description: 'Needs Steve: the Evaluator escalated (round 1)' },
      { state: 'pending', description: VISUAL_PENDING_DESCRIPTION },
    ] as GateStatus[]) {
      const h = harness({ current });
      await reconcileReviewGates(db, config(), 300, h.deps);
      expect(h.deps.postStatus).not.toHaveBeenCalled();
    }
  });

  it('posts nothing when the status read fails: an unseen approval must not be overwritten', async () => {
    const h = harness({ readOk: false });
    await reconcileReviewGates(db, config(), 300, h.deps);
    expect(h.deps.postStatus).not.toHaveBeenCalled();
  });

  it('does nothing without the review-gate token', async () => {
    const h = harness({ current: REVIEWING });
    expect(await reconcileReviewGates(db, config({ reviewGateToken: '' }), 300, h.deps)).toBe(0);
    expect(h.deps.fetchHeadSha).not.toHaveBeenCalled();
  });

  it('leaves a cycle that still owes a run to the review loop', async () => {
    db.prepare("DELETE FROM evaluator_runs WHERE lens = 'security'").run();
    const h = harness({ current: REVIEWING });
    expect(await reconcileReviewGates(db, config(), 300, h.deps)).toBe(0);
    expect(h.deps.fetchHeadSha).not.toHaveBeenCalled();
  });
});

describe('reconcileReviewGates — a head that moved after the verdict', () => {
  it('starts a new review on the new head instead of copying the old verdict onto it', async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
    const h = harness({ head: SHA_B, current: null });
    expect(await reconcileReviewGates(db, config(), 300, h.deps)).toBe(1);
    expect(h.deps.postStatus).not.toHaveBeenCalled();
    expect(events('robot_review_head_moved')).toHaveLength(1);
    expect(reviewBoundary(db, 1)).toBe(300);
  });

  it('end to end: the same pass reviews the new head, and its runs record it', async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
    const h = harness({ head: SHA_B, current: null });
    const agent = vi.fn(async (): Promise<EvaluatorTurnResult> => ({ text: shipReply, ok: true, turns: 1, tokens: 1 }));
    expect(await runEvaluatePass(db, config(), 300, { ...h.deps, runAgent: agent, fetchDiff: async () => 'd' })).toBe(1);
    expect(agent).toHaveBeenCalledTimes(2); // both lenses, on the new head
    const fresh = db.prepare('SELECT DISTINCT head_sha AS h FROM evaluator_runs WHERE started_at >= 300').all();
    expect(fresh).toEqual([{ h: SHA_B }]);
    expect(h.posts.map((p) => [p.sha, p.status.state])).toEqual([
      [SHA_B, 'pending'],
      [SHA_B, 'success'],
    ]);
  });

  it('a run with no recorded head and a stale "reviewing" on the head is reposted there (pre-fix rows)', async () => {
    seedRun('code', 'ship', null);
    seedRun('security', 'ship', null);
    const h = harness({ current: REVIEWING });
    await reconcileReviewGates(db, config(), 300, h.deps);
    expect(h.posts.map((p) => p.status.state)).toEqual(['success']);
    expect(events('robot_review_head_moved')).toHaveLength(0);
  });

  it('a run with no recorded head and no status on the head is reviewed again, not guessed', async () => {
    seedRun('code', 'ship', null);
    seedRun('security', 'ship', null);
    const h = harness({ current: null });
    await reconcileReviewGates(db, config(), 300, h.deps);
    expect(h.deps.postStatus).not.toHaveBeenCalled();
    expect(events('robot_review_head_moved')).toHaveLength(1);
  });
});

describe('reconciliation does not wait on the Evaluator budget', () => {
  it('repairs the gate while the budget is spent, and still reviews nothing', async () => {
    seedRun('code', 'ship', SHA_A);
    seedRun('security', 'ship', SHA_A);
    const h = harness({ current: REVIEWING });
    const agent = vi.fn(async (): Promise<EvaluatorTurnResult> => ({ text: shipReply, ok: true }));
    // 8 turns already spent in the window; the ceiling is 1.
    const n = await runEvaluatePass(db, config({ budgetTurns: 1 }), 300, { ...h.deps, runAgent: agent, fetchDiff: async () => 'd' });
    expect(n).toBe(0);
    expect(agent).not.toHaveBeenCalled();
    expect(h.posts).toEqual([{ sha: SHA_A, status: { state: 'success', description: 'Evaluator: ship (round 1)' } }]);
  });
});

describe('reconcileReviewGates — session PRs (the all-PRs path had the same gap)', () => {
  const sessionPr = (over: Partial<OtherPr> = {}): OtherPr => ({
    number: 600,
    title: 'feat: a session change',
    body: '',
    headRefName: 'pd-1-thing',
    headRefOid: SHA_B,
    baseRefName: 'main',
    isCrossRepository: false,
    isDraft: false,
    labels: [],
    files: [{ path: 'apps/web/src/a.ts' }],
    ...over,
  });
  /** Both lenses reviewed the session PR's head. */
  function seedSession(verdict: EvaluatorVerdict, prNumber = 600, head = SHA_B): void {
    for (const lens of ['code', 'security'] as EvaluatorLens[]) {
      const id = startEvaluatorRun(db, { ticketId: 1, prNumber, round: 1, model: 'm', lens, headSha: head }, 200);
      finishEvaluatorRun(db, id, { report: { verdict, summary: 's', findings: [] } }, 201);
    }
  }
  const cfg = () => config({ allPrs: true, adopt: false });

  it('repairs a lost ship post on a session PR head', async () => {
    seedSession('ship');
    const h = harness({ current: REVIEWING });
    await reconcileReviewGates(db, cfg(), 300, { ...h.deps, listPrs: async () => [sessionPr()] });
    expect(h.posts).toEqual([{ sha: SHA_B, status: { state: 'success', description: 'Evaluator: ship (round 1)' } }]);
  });

  it("leaves Steve's approval, a head not yet reviewed, and a PR the Robot path owns", async () => {
    seedSession('ship');
    const approved = harness({ current: { state: 'success', description: STEVE_APPROVED_DESCRIPTION } });
    await reconcileReviewGates(db, cfg(), 300, { ...approved.deps, listPrs: async () => [sessionPr()] });
    expect(approved.deps.postStatus).not.toHaveBeenCalled();

    const unreviewed = harness({ current: null });
    await reconcileReviewGates(db, cfg(), 300, { ...unreviewed.deps, listPrs: async () => [sessionPr({ headRefOid: 'c'.repeat(40) })] });
    expect(unreviewed.deps.postStatus).not.toHaveBeenCalled();

    // PR 576 is ticket 1's in-review Robot PR: the Robot-path reconciliation handles it, not this one.
    db.prepare('DELETE FROM evaluator_runs').run();
    seedSession('ship', TARGET.prNumber, SHA_A);
    const owned = harness({ current: REVIEWING, head: null });
    await reconcileReviewGates(db, cfg(), 300, { ...owned.deps, listPrs: async () => [sessionPr({ number: TARGET.prNumber, headRefOid: SHA_A })] });
    expect(owned.deps.postStatus).not.toHaveBeenCalled();
  });
});
