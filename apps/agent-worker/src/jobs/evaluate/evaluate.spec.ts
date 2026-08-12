import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureRunsTable, startRun, finishRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import { budgetUsage } from '../robot/budget';
import { evaluateOnePr, runEvaluatePass } from './evaluate';
import { ensureEvaluatorRunsTable, evaluatorBudgetUsage, recentEvaluatorRuns } from './evaluator-runs';
import { pendingEvaluatorBrief } from './brief';
import { MAX_EVALUATION_ROUNDS } from './verdict';
import type { EvaluatorTurnResult } from './evaluate-agent';

const TARGET = { ticketId: 1, repo: 'scolacur/personal-dashboard', prNumber: 314 };

function config(over: Partial<AgentWorkerConfig['evaluator']> = {}): AgentWorkerConfig {
  const base = loadConfig({});
  return { ...base, evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, ...over } };
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
  it('stops re-queueing once the cap is reached, and leaves the finding for the human', async () => {
    // A revise → rework → hand-off → revise cycle is unbounded without this (PD-420 by a new road).
    for (let i = 0; i < MAX_EVALUATION_ROUNDS; i++) {
      db.prepare("UPDATE agent_tickets SET agent_state = 'in-review' WHERE id = 1").run();
      await evaluateOnePr(db, config(), TARGET, { runAgent: fakeAgent(reviseReply), fetchDiff: async () => 'd' }, 200 + i);
    }
    const reactivations = eventsOfType('robot_reactivated').length;
    expect(reactivations).toBe(MAX_EVALUATION_ROUNDS - 1);
    // The verdict is still recorded on the final round — the human sees it, it just isn't acted on.
    expect(eventsOfType('robot_evaluated')).toHaveLength(MAX_EVALUATION_ROUNDS);
    expect(agentState()).toBe('in-review');
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
