import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureRunsTable, startRun, finishRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import { budgetUsage } from '../robot/budget';
import { evaluateOnePr, runEvaluatePass } from './evaluate';
import {
  alreadyEvaluated,
  headEvaluated,
  INTERRUPTED_RUN_ERROR,
  reclaimInterruptedEvaluatorRuns,
  ensureEvaluatorRunsTable,
  evaluatorBudgetUsage,
  finishEvaluatorRun,
  recentEvaluatorRuns,
  startEvaluatorRun,
  updateEvaluatorRunProgress,
  lensNeedsRun,
} from './evaluator-runs';
import { pendingEvaluatorBrief } from './brief';
import { MAX_EVALUATION_ROUNDS } from './verdict';
import type { EvaluatorLens } from '@dashboard/shared';
import type { EvaluatorTurnResult } from './evaluate-agent';

const TARGET = { ticketId: 1, repo: 'scolacur/personal-dashboard', prNumber: 314 };

function config(over: Partial<AgentWorkerConfig['evaluator']> = {}): AgentWorkerConfig {
  const base = loadConfig({});
  // The security lens (PD-767) is off here so these tests keep exercising the code reviewer alone;
  // the two-lens behaviour has its own describe block below.
  // The all-PRs path (PD-712) is off too: it has its own spec, and here it would reach for `gh`.
  return { ...base, evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, securityEnabled: false, allPrs: false, ...over } };
}

/** An agent stand-in returning canned text. Nothing here spawns a real session. */
function fakeAgent(text: string, ok = true, usage: { turns?: number; tokens?: number } = { turns: 4, tokens: 900 }) {
  return vi.fn(async (): Promise<EvaluatorTurnResult> => ({ text, ok, ...usage }));
}

const shipReply = '{"verdict":"ship","summary":"Meets every Done When item.","findings":[]}';
const reviseReply = JSON.stringify({
  verdict: 'revise',
  summary: 'Adds a bespoke helper that already exists.',
  findings: [
    { kind: 'redundancy', blocking: true, where: 'apps/web/src/lib/fmt.ts:3', what: 'adds formatBytes', insteadUse: 'packages/shared/fmt' },
  ],
});

let db: Database.Database;

function eventsOfType(type: string): { detail: string }[] {
  return db.prepare('SELECT detail FROM agent_ticket_events WHERE ticket_id = 1 AND type = ?').all(type) as {
    detail: string;
  }[];
}
function agentState(): string {
  return (db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = 1').get() as { s: string }).s;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
  `);
  ensureRunsTable(db);
  ensureRobotStateTable(db);
  ensureEvaluatorRunsTable(db);
  db.prepare(
    "INSERT INTO agent_tickets (id, title, body, status, assignee, agent_state) VALUES (1, 'Add a thing', '## Done When\\n- it works', 'queue', 'robot', 'in-review')",
  ).run();
  const runId = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/220' }, 10);
  finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 100);
});

describe('evaluateOnePr — verdicts', () => {
  it('records a ship on the timeline and leaves the ticket in review', () => {
    // A timeline that only ever shows the Evaluator complaining reads as noise; "it reviewed this
    // and was satisfied" is what a human wants before merging.
    return evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(shipReply), fetchDiff: async () => 'diff' }, 200).then(
      (report) => {
        expect(report?.verdict).toBe('ship');
        expect(eventsOfType('robot_evaluated')).toHaveLength(1);
        expect(agentState()).toBe('in-review');
      },
    );
  });

  it('re-queues for rework on a revise, through the loop’s existing reactivation', async () => {
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(reviseReply), fetchDiff: async () => 'diff' }, 200);
    expect(agentState()).toBe('queued');
    expect(eventsOfType('robot_reactivated')).toHaveLength(1);
    expect(eventsOfType('robot_evaluated')).toHaveLength(1);
  });

  it('records an escalate without re-queueing — a human decides, the Robot does not retry', async () => {
    const reply = '{"verdict":"escalate","summary":"The ticket contradicts D-039.","findings":[]}';
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(reply), fetchDiff: async () => 'diff' }, 200);
    expect(agentState()).toBe('in-review');
    expect(eventsOfType('robot_reactivated')).toHaveLength(0);
  });
});

describe('evaluateOnePr — failures never approve and never advance', () => {
  it('an unparseable reply records an error and leaves the PR alone', async () => {
    const report = await evaluateOnePr(
      db,
      config(),
      TARGET,
      { runAgent: fakeAgent('I was unable to review this.'), fetchDiff: async () => 'diff' },
      200,
    );
    expect(report).toBeNull();
    expect(agentState()).toBe('in-review');
    // No verdict event at all — a failed evaluation must not look like a satisfied one.
    expect(eventsOfType('robot_evaluated')).toHaveLength(0);
    expect(recentEvaluatorRuns(db, 1)[0].error).toMatch(/unparseable/);
  });

  it('an agent error records an error and leaves the PR alone', async () => {
    const report = await evaluateOnePr(
      db,
      config(),
      TARGET,
      { runAgent: fakeAgent('Credit balance too low', false), fetchDiff: async () => 'diff' },
      200,
    );
    expect(report).toBeNull();
    expect(eventsOfType('robot_evaluated')).toHaveLength(0);
    expect(recentEvaluatorRuns(db, 1)[0].error).toMatch(/Credit balance/);
  });

  it('a diff-fetch failure never reaches the agent', async () => {
    const agent = fakeAgent(shipReply);
    const report = await evaluateOnePr(db, config(), TARGET, { runAgent: agent, fetchDiff: async () => null }, 200);
    expect(report).toBeNull();
    expect(agent).not.toHaveBeenCalled();
    // An empty diff would be read as "nothing changed" and could produce a confident, wrong ship.
    expect(recentEvaluatorRuns(db, 1)[0].error).toMatch(/diff fetch failed/);
  });
});

describe('the round cap', () => {
  /** Drive `n` revise rounds, re-arming the PR to in-review before each so a round is reviewable. */
  async function driveReviseRounds(cfg: AgentWorkerConfig, n: number) {
    for (let i = 0; i < n; i++) {
      db.prepare("UPDATE agent_tickets SET agent_state = 'in-review' WHERE id = 1").run();
      await evaluateOnePr(db, cfg, TARGET, { runAgent: fakeAgent(reviseReply), fetchDiff: async () => 'd' }, 200 + i);
    }
  }

  it('stops re-queueing once the cap is reached, and leaves the finding for the human', async () => {
    // A revise → rework → hand-off → revise cycle is unbounded without this (PD-420 by a new road).
    await driveReviseRounds(config(), MAX_EVALUATION_ROUNDS);
    const reactivations = eventsOfType('robot_reactivated').length;
    expect(reactivations).toBe(MAX_EVALUATION_ROUNDS - 1);
    // The verdict is still recorded on the final round — the human sees it, it just isn't acted on.
    expect(eventsOfType('robot_evaluated')).toHaveLength(MAX_EVALUATION_ROUNDS);
    expect(agentState()).toBe('in-review');
  });

  it('defaults to 2 when EVALUATOR_MAX_ROUNDS is unset (behaviour unchanged, PD-761)', () => {
    // The whole ticket: the production value does not move. An unset env yields the old cap.
    expect(loadConfig({}).evaluator.maxRounds).toBe(2);
  });

  it('honours a higher configured cap, re-queueing where the default would stop (PD-761)', async () => {
    // With EVALUATOR_MAX_ROUNDS=3, a third revise is still re-worked rather than left for the human.
    await driveReviseRounds(config({ maxRounds: 3 }), 3);
    expect(eventsOfType('robot_reactivated')).toHaveLength(2); // rounds 1 and 2 re-queued; round 3 at the cap
    expect(eventsOfType('robot_evaluated')).toHaveLength(3);
    expect(agentState()).toBe('in-review');
  });

  it('a configured cap of 3 is honoured end-to-end from the env var', async () => {
    // Via loadConfig, not a hand-built object — proves EVALUATOR_MAX_ROUNDS reaches the review path.
    const base = loadConfig({ EVALUATOR_MAX_ROUNDS: '3' });
    const cfg = { ...base, evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, securityEnabled: false, allPrs: false } };
    expect(cfg.evaluator.maxRounds).toBe(3);
    await driveReviseRounds(cfg, 2);
    // At round 2 the default-2 cap would already have stopped; with cap 3 both rounds re-queue.
    expect(eventsOfType('robot_reactivated')).toHaveLength(2);
  });

  it('falls back to 2 on an invalid EVALUATOR_MAX_ROUNDS (PD-761)', () => {
    for (const bad of ['0', '-1', 'abc', '2.5', ' ']) {
      expect(loadConfig({ EVALUATOR_MAX_ROUNDS: bad }).evaluator.maxRounds).toBe(2);
    }
  });
});

describe('budget separation — the premise of the ticket', () => {
  it('evaluator spend does not appear in the Robot loop’s budget', async () => {
    const before = budgetUsage(db, 0);
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(shipReply), fetchDiff: async () => 'd' }, 200);

    // The Robot's ceiling (PD-463) sums every row in agent_runs with no discriminator. If evaluation
    // spend landed there, reviewing a PR could pause dispatch — and judging a run would inflate the
    // number used to decide whether that run was affordable.
    expect(budgetUsage(db, 0).turns).toBe(before.turns);
    expect(evaluatorBudgetUsage(db, 0).turns).toBe(4);
    expect(evaluatorBudgetUsage(db, 0).tokens).toBe(900);
  });

  it('a breached evaluator budget skips evaluation without pausing dispatch', async () => {
    const agent = fakeAgent(shipReply);
    // Pre-spend the window.
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(shipReply), fetchDiff: async () => 'd' }, 200);
    const n = await runEvaluatePass(db, config({ budgetTurns: 1 }), 300, { runAgent: agent, fetchDiff: async () => 'd' });
    expect(n).toBe(0);
    expect(agent).not.toHaveBeenCalled();
    // Crucially: no dispatch pause was written. The Robot loop keeps working.
    const paused = db.prepare("SELECT value FROM robot_state WHERE key = 'dispatch_paused'").get();
    expect(paused).toBeUndefined();
  });
});

describe('runEvaluatePass — gating', () => {
  it('does nothing at all when disabled', async () => {
    const agent = fakeAgent(shipReply);
    const n = await runEvaluatePass(db, { ...config(), evaluator: { ...config().evaluator, enabled: false } }, 200, {
      runAgent: agent,
      fetchDiff: async () => 'd',
    });
    expect(n).toBe(0);
    expect(agent).not.toHaveBeenCalled();
  });

  it('does not re-evaluate the same hand-off twice', async () => {
    const agent = fakeAgent(shipReply);
    const deps = { runAgent: agent, fetchDiff: async () => 'd' };
    expect(await runEvaluatePass(db, config(), 200, deps)).toBe(1);
    expect(await runEvaluatePass(db, config(), 300, deps)).toBe(0);
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it('evaluates again after a NEW hand-off', async () => {
    const agent = fakeAgent(shipReply);
    const deps = { runAgent: agent, fetchDiff: async () => 'd' };
    await runEvaluatePass(db, config(), 200, deps);
    // A rework handed off again — a genuinely new thing to review.
    const runId = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/220' }, 400);
    finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 500);
    db.prepare("UPDATE agent_tickets SET agent_state = 'in-review' WHERE id = 1").run();
    expect(await runEvaluatePass(db, config(), 600, deps)).toBe(1);
  });
});

describe('pendingEvaluatorBrief — how a revise reaches the DB-blind Robot', () => {
  it('is pending after a revise and names the existing helper', async () => {
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(reviseReply), fetchDiff: async () => 'd' }, 200);
    const brief = pendingEvaluatorBrief(db, 1);
    expect(brief).toMatch(/MUST FIX/);
    expect(brief).toContain('packages/shared/fmt');
  });

  it('is NOT pending after a ship', async () => {
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(shipReply), fetchDiff: async () => 'd' }, 200);
    expect(pendingEvaluatorBrief(db, 1)).toBeNull();
  });

  it('is consumed by the dispatch that follows it, so a fixed complaint is not re-injected', async () => {
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(reviseReply), fetchDiff: async () => 'd' }, 200);
    expect(pendingEvaluatorBrief(db, 1)).not.toBeNull();
    db.prepare("INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (1, 'robot_dispatched', '{}', 300)").run();
    expect(pendingEvaluatorBrief(db, 1)).toBeNull();
  });
});

describe('timeline visibility', () => {
  it('writes a start marker before the pass, so a FAILED evaluation is still legible', async () => {
    // The failure path writes no verdict on purpose. Without the start event, a crashed or hung
    // evaluation would leave the timeline showing nothing at all — indistinguishable from one that
    // never ran.
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent('garbage'), fetchDiff: async () => 'd' }, 200);
    expect(eventsOfType('robot_evaluating')).toHaveLength(1);
    expect(eventsOfType('robot_evaluated')).toHaveLength(0);
  });

  it('carries the counts the timeline renders', async () => {
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(reviseReply), fetchDiff: async () => 'd' }, 200);
    const detail = JSON.parse(eventsOfType('robot_evaluated')[0].detail);
    expect(detail).toMatchObject({ verdict: 'revise', findings: 1, blockingFindings: 1, round: 1 });
  });
});

describe('review-gate status on the reviewed commit (PD-763)', () => {
  const SHA = 'a'.repeat(40);
  function gated() {
    db.exec('ALTER TABLE agent_tickets ADD COLUMN display_id TEXT');
    db.prepare("UPDATE agent_tickets SET display_id = 'PD-1' WHERE id = 1").run();
    const posts: { sha: string; state: string; description: string; url: string | null }[] = [];
    const deps = {
      fetchHeadSha: async () => SHA,
      postStatus: async (_repo: string, sha: string, s: { state: string; description: string }, url: string | null) => {
        posts.push({ sha, state: s.state, description: s.description, url });
        return true;
      },
    };
    const cfg = config({ reviewGateToken: 'tok', reviewGateTicketUrlBase: 'http://dash/devops/tickets' });
    return { posts, deps, cfg };
  }

  it('posts pending while reviewing, then success on ship, on the SHA pinned before the diff', async () => {
    const { posts, deps, cfg } = gated();
    await evaluateOnePr(db, cfg, TARGET, { ...deps, runAgent: fakeAgent(shipReply), fetchDiff: async () => 'diff' }, 200);
    expect(posts.map((p) => p.state)).toEqual(['pending', 'success']);
    expect(posts.every((p) => p.sha === SHA)).toBe(true);
    expect(posts[1].url).toBe('http://dash/devops/tickets/PD-1');
  });

  it('a failed evaluation ends in failure, never success', async () => {
    const { posts, deps, cfg } = gated();
    await evaluateOnePr(db, cfg, TARGET, { ...deps, runAgent: fakeAgent('no json here'), fetchDiff: async () => 'diff' }, 200);
    expect(posts.at(-1)?.state).toBe('failure');
    const posts2: string[] = [];
    await evaluateOnePr(
      db,
      cfg,
      TARGET,
      {
        fetchHeadSha: async () => SHA,
        postStatus: async (_r, _s, st) => (posts2.push(st.state), true),
        runAgent: fakeAgent(shipReply),
        fetchDiff: async () => null,
      },
      201,
    );
    expect(posts2.at(-1)).toBe('failure');
  });

  it('posts nothing without the token, and nothing when the head SHA cannot be read', async () => {
    const posts: string[] = [];
    const postStatus = async () => (posts.push('x'), true);
    await evaluateOnePr(db, config(), TARGET, { postStatus, runAgent: fakeAgent(shipReply), fetchDiff: async () => 'd' }, 200);
    expect(posts).toEqual([]);
    const { cfg } = gated();
    await evaluateOnePr(db, cfg, TARGET, { postStatus, fetchHeadSha: async () => null, runAgent: fakeAgent(shipReply), fetchDiff: async () => 'd' }, 300);
    expect(posts).toEqual([]);
  });
});

describe('two reviewers: code and security (PD-767)', () => {
  const secReply = (verdict: string, findings: unknown[] = []) => JSON.stringify({ verdict, summary: `security ${verdict}`, findings });
  const sqlFinding = { kind: 'injection', blocking: true, where: 'apps/server/src/x.ts:9', what: 'builds SQL by concatenation' };
  /** Answers per reviewer: the security prompt identifies itself as "the security reviewer". */
  function byLens(code: string, security: string) {
    return vi.fn(async (_c: AgentWorkerConfig, system: string): Promise<EvaluatorTurnResult> => ({
      text: system.includes('the security reviewer') ? security : code,
      ok: true,
      turns: 2,
      tokens: 100,
    }));
  }
  const both = () => config({ securityEnabled: true });
  const lensOf = (e: { detail: string }) => (JSON.parse(e.detail) as { lens?: string }).lens;

  beforeEach(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER,
      title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL)`);
    db.exec('ALTER TABLE agent_tickets ADD COLUMN display_id TEXT');
    db.prepare("UPDATE agent_tickets SET display_id = 'PD-1' WHERE id = 1").run();
  });

  it('runs both on one diff, labels each verdict, and ships only when both ship', async () => {
    const agent = byLens(shipReply, secReply('ship'));
    const report = await evaluateOnePr(db, both(), TARGET, { runAgent: agent, fetchDiff: async () => 'd' }, 200);
    expect(agent).toHaveBeenCalledTimes(2);
    expect(report?.verdict).toBe('ship');
    expect(eventsOfType('robot_evaluated').map(lensOf)).toEqual(['code', 'security']);
    expect(agentState()).toBe('in-review');
  });

  it('a security revise alone re-queues once, and the brief carries its finding', async () => {
    await evaluateOnePr(db, both(), TARGET, { runAgent: byLens(shipReply, secReply('revise', [sqlFinding])), fetchDiff: async () => 'd' }, 200);
    expect(agentState()).toBe('queued');
    expect(eventsOfType('robot_reactivated')).toHaveLength(1);
    expect(pendingEvaluatorBrief(db, 1)).toContain('builds SQL by concatenation');
  });

  it('when both revise, the Robot gets ONE rework with both sets of findings', async () => {
    await evaluateOnePr(db, both(), TARGET, { runAgent: byLens(reviseReply, secReply('revise', [sqlFinding])), fetchDiff: async () => 'd' }, 200);
    expect(eventsOfType('robot_reactivated')).toHaveLength(1);
    const brief = pendingEvaluatorBrief(db, 1)!;
    expect(brief).toContain('packages/shared/fmt');
    expect(brief).toContain('builds SQL by concatenation');
  });

  it('a found secret escalates, never re-queues, and raises an urgent notification without the value', async () => {
    const secret = { kind: 'secret', blocking: true, where: 'apps/server/.env.example:3', what: 'a live-looking API key' };
    const report = await evaluateOnePr(db, both(), TARGET, { runAgent: byLens(shipReply, secReply('escalate', [secret])), fetchDiff: async () => 'd' }, 200);
    expect(report?.verdict).toBe('escalate');
    expect(agentState()).toBe('in-review');
    const n = db.prepare('SELECT kind, title, body FROM agent_notifications').all() as { kind: string; title: string; body: string }[];
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'agent_needs_human', title: 'Possible secret in PR #314 (PD-1): rotate it' });
    expect(n[0].body).toContain('apps/server/.env.example:3');
  });

  it('one reviewer failing means no verdict for the PR: nothing ships, nothing re-queues', async () => {
    const report = await evaluateOnePr(db, both(), TARGET, { runAgent: byLens(shipReply, 'not json'), fetchDiff: async () => 'd' }, 200);
    expect(report).toBeNull();
    expect(agentState()).toBe('in-review');
    expect(eventsOfType('robot_evaluated').map(lensOf)).toEqual(['code']);
  });

  it('review-gate needs both: success on two ships, failure if either cannot decide', async () => {
    const posts: string[] = [];
    const deps = { fetchHeadSha: async () => 'b'.repeat(40), postStatus: async (_r: string, _s: string, st: { state: string }) => (posts.push(st.state), true) };
    const cfg = config({ securityEnabled: true, reviewGateToken: 'tok' });
    await evaluateOnePr(db, cfg, TARGET, { ...deps, runAgent: byLens(shipReply, secReply('ship')), fetchDiff: async () => 'd' }, 200);
    expect(posts).toEqual(['pending', 'success']);
    posts.length = 0;
    // PD-883: a lens that already shipped is not re-reviewed in the same cycle. A NEW hand-off starts
    // a fresh cycle, so both lenses are evaluated again — this time the security lens cannot decide.
    const r = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/220' }, 290);
    finishRun(db, r, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 295);
    await evaluateOnePr(db, cfg, TARGET, { ...deps, runAgent: byLens(shipReply, 'nope'), fetchDiff: async () => 'd' }, 300);
    expect(posts.at(-1)).toBe('failure');
  });

  it('counts rounds per reviewer, so two reviewers do not hit the cap twice as fast', async () => {
    await evaluateOnePr(db, both(), TARGET, { runAgent: byLens(reviseReply, secReply('ship')), fetchDiff: async () => 'd' }, 200);
    expect(eventsOfType('robot_reactivated')).toHaveLength(1); // round 1 of 2 for the code reviewer
    const rounds = (eventsOfType('robot_evaluated').map((e) => JSON.parse(e.detail) as { round: number; lens: string }));
    expect(rounds).toEqual([expect.objectContaining({ lens: 'code', round: 1 }), expect.objectContaining({ lens: 'security', round: 1 })]);
  });
});

// ── PD-909: live turns / tokens per lens run ──────────────────────────────────

describe('live evaluator progress (PD-909)', () => {
  const row = () =>
    db.prepare('SELECT turns, tokens, finished_at FROM evaluator_runs ORDER BY id DESC LIMIT 1').get() as {
      turns: number | null;
      tokens: number | null;
      finished_at: number | null;
    };

  it('writes the lens run’s progress while the review runs, then the authoritative totals', async () => {
    let midRun: ReturnType<typeof row> | undefined;
    const runAgent = vi.fn(async (_c: unknown, _s: string, _p: string, onProgress?: (t: number, k?: number) => void) => {
      onProgress?.(1, 800);
      onProgress?.(2); // no usage this turn — keeps the known total
      midRun = row();
      return { text: shipReply, ok: true, turns: 4, tokens: 900 } satisfies EvaluatorTurnResult;
    });

    await evaluateOnePr(db, config(), TARGET, { runAgent, fetchDiff: async () => 'diff' }, 200);

    expect(midRun).toEqual({ turns: 2, tokens: 800, finished_at: null });
    expect(row()).toMatchObject({ turns: 4, tokens: 900 });
  });

  it('never touches a finished run — a late callback cannot overwrite the final totals', () => {
    const id = startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm' }, 10);
    updateEvaluatorRunProgress(db, id, 3, 500);
    finishEvaluatorRun(db, id, { error: 'x', turns: 5, tokens: 700 }, 20);
    updateEvaluatorRunProgress(db, id, 9, 9999);
    expect(row()).toMatchObject({ turns: 5, tokens: 700 });
  });
});

describe('one error retry per lens, per review cycle (PD-883)', () => {
  const secReply = (verdict: string, findings: unknown[] = []) => JSON.stringify({ verdict, summary: `security ${verdict}`, findings });
  const both = () => config({ securityEnabled: true, reviewGateToken: 'tok' });
  const lensOf = (e: { detail: string }) => (JSON.parse(e.detail) as { lens?: string }).lens;

  const posts: string[] = [];
  const gateDeps = {
    fetchHeadSha: async () => 'c'.repeat(40),
    postStatus: async (_r: string, _s: string, st: { state: string }) => (posts.push(st.state), true),
  };

  /** An agent that answers per lens (security prompt self-identifies) and records which lens it saw. */
  function recordingAgent(answers: { code: string; security: string }) {
    const calls: string[] = [];
    const fn = vi.fn(async (_c: AgentWorkerConfig, system: string): Promise<EvaluatorTurnResult> => {
      const lens = system.includes('the security reviewer') ? 'security' : 'code';
      calls.push(lens);
      return { text: lens === 'security' ? answers.security : answers.code, ok: true, turns: 2, tokens: 100 };
    });
    return { fn, calls };
  }

  beforeEach(() => {
    posts.length = 0;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER,
      title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL)`);
    db.exec('ALTER TABLE agent_tickets ADD COLUMN display_id TEXT');
    db.prepare("UPDATE agent_tickets SET display_id = 'PD-1' WHERE id = 1").run();
  });

  it('retries ONLY the errored lens next poll; its later ship folds the prior code ship into success', async () => {
    // Pass 1: code ships, the security reviewer returns garbage. The PR fails for now; retry pending.
    const a1 = recordingAgent({ code: shipReply, security: 'not json' });
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a1.fn, fetchDiff: async () => 'd' }, 200);
    expect(a1.calls).toEqual(['code', 'security']);
    expect(posts.at(-1)).toBe('failure');
    expect(eventsOfType('robot_evaluated').map(lensOf)).toEqual(['code']); // only code produced a verdict

    // Pass 2: ONLY the security lens is re-run — code already shipped this cycle — and its ship
    // combines with the folded code ship to open the gate.
    posts.length = 0;
    const a2 = recordingAgent({ code: shipReply, security: secReply('ship') });
    const report = await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a2.fn, fetchDiff: async () => 'd' }, 300);
    expect(a2.calls).toEqual(['security']);
    expect(report?.verdict).toBe('ship');
    expect(posts.at(-1)).toBe('success');
    expect(agentState()).toBe('in-review');
  });

  it('a second error leaves the gate failing, does not run a third time, and notifies once naming the lens', async () => {
    const garbage = () => recordingAgent({ code: shipReply, security: 'still not json' });
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: garbage().fn, fetchDiff: async () => 'd' }, 200); // security error #1
    // No notification yet — the retry is still pending.
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_notifications WHERE kind = 'agent_needs_human'").get()).toMatchObject({ n: 0 });

    posts.length = 0;
    const a2 = garbage();
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a2.fn, fetchDiff: async () => 'd' }, 300); // security error #2 (retry used)
    expect(a2.calls).toEqual(['security']);
    expect(posts.at(-1)).toBe('failure');

    const notifs = db
      .prepare("SELECT title, body FROM agent_notifications WHERE kind = 'agent_needs_human'")
      .all() as { title: string; body: string }[];
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toContain('PR #314');
    expect(notifs[0].body).toContain('security');

    // A third poll must NOT run the security lens again — its one retry is used.
    posts.length = 0;
    const a3 = recordingAgent({ code: shipReply, security: secReply('ship') });
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a3.fn, fetchDiff: async () => 'd' }, 400);
    expect(a3.calls).toEqual([]);
    // Still exactly one notification (notify's unread (ticket, kind) dedup).
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_notifications WHERE kind = 'agent_needs_human'").get()).toMatchObject({ n: 1 });
  });

  it('alreadyEvaluated: one errored lens is NOT done, two errors IS done', async () => {
    const lenses: EvaluatorLens[] = ['code', 'security'];
    expect(alreadyEvaluated(db, 1, 314, 100, lenses)).toBe(false);
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: recordingAgent({ code: shipReply, security: 'x' }).fn, fetchDiff: async () => 'd' }, 200);
    expect(alreadyEvaluated(db, 1, 314, 100, lenses)).toBe(false); // security retry pending
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: recordingAgent({ code: shipReply, security: 'x' }).fn, fetchDiff: async () => 'd' }, 300);
    expect(alreadyEvaluated(db, 1, 314, 100, lenses)).toBe(true); // security retry used
  });

  it('a new hand-off boundary resets the retry', async () => {
    // Exhaust the security retry in the first cycle.
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: recordingAgent({ code: shipReply, security: 'x' }).fn, fetchDiff: async () => 'd' }, 200);
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: recordingAgent({ code: shipReply, security: 'x' }).fn, fetchDiff: async () => 'd' }, 300);
    // A new hand-off advances `since` → a fresh cycle → both lenses evaluated again.
    const r = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/220' }, 390);
    finishRun(db, r, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 395);
    posts.length = 0;
    const a = recordingAgent({ code: shipReply, security: secReply('ship') });
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a.fn, fetchDiff: async () => 'd' }, 400);
    expect(a.calls).toEqual(['code', 'security']);
    expect(posts.at(-1)).toBe('success');
  });

  // PR #487 (PD-761): a worker restart killed both lens runs mid-review, leaving rows that were never
  // finished. Under the old "any code row exists" rule the PR was skipped forever and never got a
  // review-gate status. An unfinished row now counts as one errored run, so the lens is retried.
  it('retries lenses whose runs a worker restart left unfinished (the PR #487 strand)', async () => {
    startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm', lens: 'code' }, 150);
    startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm', lens: 'security' }, 150);
    expect(alreadyEvaluated(db, 1, 314, 100, ['code', 'security'])).toBe(false);
    const a = recordingAgent({ code: shipReply, security: secReply('ship') });
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a.fn, fetchDiff: async () => 'd' }, 300);
    expect(a.calls.sort()).toEqual(['code', 'security']);
    expect(posts.at(-1)).toBe('success');
  });

  // PD-919: a restart-killed review is reclaimed at boot and then counts as nothing at all.
  it('reclaim closes only the open rows, as interrupted', () => {
    const open = startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm', lens: 'code' }, 150);
    const done = startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm', lens: 'security' }, 150);
    finishEvaluatorRun(db, done, { error: 'unparseable report: x' }, 160);
    expect(reclaimInterruptedEvaluatorRuns(db, 999)).toBe(1);
    const rows = db.prepare('SELECT id, error, finished_at FROM evaluator_runs ORDER BY id').all();
    expect(rows).toEqual([
      { id: open, error: INTERRUPTED_RUN_ERROR, finished_at: 999 },
      { id: done, error: 'unparseable report: x', finished_at: 160 },
    ]);
    expect(reclaimInterruptedEvaluatorRuns(db, 1000)).toBe(0); // idempotent
  });

  it('an interrupted run uses neither the error retry nor a round', async () => {
    startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm', lens: 'code' }, 150);
    startEvaluatorRun(db, { ticketId: 1, prNumber: 314, round: 1, model: 'm', lens: 'security' }, 150);
    reclaimInterruptedEvaluatorRuns(db, 160);

    // A real error now is the security lens's FIRST failure: its retry is still pending.
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: recordingAgent({ code: shipReply, security: 'nope' }).fn, fetchDiff: async () => 'd' }, 200);
    expect(alreadyEvaluated(db, 1, 314, 100, ['code', 'security'])).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_notifications WHERE kind = 'agent_needs_human'").get()).toMatchObject({ n: 0 });
    // …and the review it ran was round 1, not round 2.
    const rounds = eventsOfType('robot_evaluating').map((e) => (JSON.parse(e.detail) as { round: number }).round);
    expect(rounds).toEqual([1, 1]);

    // The retry then ships it.
    const a = recordingAgent({ code: shipReply, security: secReply('ship') });
    await evaluateOnePr(db, both(), TARGET, { ...gateDeps, runAgent: a.fn, fetchDiff: async () => 'd' }, 300);
    expect(a.calls).toEqual(['security']);
    expect(posts.at(-1)).toBe('success');
  });

  it('a non-Robot head is settled only by a verdict or a used retry; interrupted runs never count (all-PRs path)', () => {
    const codeRun = (startedAt: number) =>
      startEvaluatorRun(db, { ticketId: 0, prNumber: 600, round: 1, model: 'm', lens: 'code', headSha: 'abc' }, startedAt);
    // An interrupted-only review does not settle the head — a fresh review is owed (PD-919).
    startEvaluatorRun(db, { ticketId: 0, prNumber: 600, round: 1, model: 'm', lens: 'code', headSha: 'abc' }, 150);
    reclaimInterruptedEvaluatorRuns(db, 160);
    expect(headEvaluated(db, 600, 'abc', ['code'])).toBe(false);
    // One real (non-interrupted) error: the code lens's one retry is still pending, so still not done.
    finishEvaluatorRun(db, codeRun(170), { error: 'x' }, 180);
    expect(headEvaluated(db, 600, 'abc', ['code'])).toBe(false);
    // The second error uses the retry → the head is settled (left to Steve) (PD-884).
    finishEvaluatorRun(db, codeRun(190), { error: 'y' }, 200);
    expect(headEvaluated(db, 600, 'abc', ['code'])).toBe(true);
  });

  it('keeps the full unparseable reply up to the 20k cap, not a 500-char head', async () => {
    const long = `${'x'.repeat(30_000)} no-json-here`; // no JSON object at all → unparseable
    await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(long), fetchDiff: async () => 'd' }, 200);
    const err = recentEvaluatorRuns(db, 1)[0].error ?? '';
    expect(err).toMatch(/unparseable/);
    expect(err.length).toBeGreaterThan(500); // not the old 500-char slice
    expect(err.length).toBeLessThanOrEqual(20_100); // bounded by the ~20k cap (+ short prefix)
  });
});

describe('lensNeedsRun honours the configured round cap (PD-761)', () => {
  const revisedTwice = { verdictRuns: 2, errorRuns: 0, hasTerminalVerdict: false };

  it('settles at the default cap when none is given', () => {
    expect(lensNeedsRun(revisedTwice)).toBe(false);
  });

  it('keeps a lens running past the default when EVALUATOR_MAX_ROUNDS raises the cap', () => {
    expect(lensNeedsRun(revisedTwice, 4)).toBe(true);
    expect(lensNeedsRun({ ...revisedTwice, verdictRuns: 4 }, 4)).toBe(false);
  });
});
