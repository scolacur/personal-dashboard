import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTaskPrompt, ROBOT_EVENT } from '@dashboard/shared';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureRunsTable } from '../robot/runs';
import { logMilestone } from '../robot/events';
import { robotClaimedBranches } from '../robot/robot';
import { ensureEvaluatorRunsTable, finishEvaluatorRun, startEvaluatorRun } from './evaluator-runs';
import { adoptableTicket, adoptedFrom, adoptedPrNumbers, branchDisplayId, headVerdict, pendingAdoptions } from './adoption';
import { runAdoptionPass } from './adopt-pass';
import { evaluateNextOtherPr, type OtherPr } from './all-prs';
import { ensureConflictAttemptsTable, nextConflictedPr } from '../conflicts/pass';
import type { StatusRead } from './review-gate';

const SHA = 'a'.repeat(40);
const MIN = 60_000;
const pr = (over: Partial<OtherPr> = {}): OtherPr => ({
  number: 500,
  title: 'feat: a thing',
  body: 'Does the thing.',
  headRefName: 'pd-705-thing',
  headRefOid: SHA,
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false,
  labels: [],
  files: [{ path: 'apps/web/src/a.ts' }],
  ...over,
});

function cfg(over: Partial<AgentWorkerConfig['evaluator']> = {}): AgentWorkerConfig {
  const base = loadConfig({ ROBOT_GITHUB_TOKEN: 'ghp_w' });
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
  ensureConflictAttemptsTable(db);
  db.prepare("INSERT INTO agent_projects (id, robot_enabled, github_repo) VALUES (1, 1, 'scolacur/personal-dashboard')").run();
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, body, assignee) VALUES (705, 'PD-705', 'Do the thing', '## Done When\n- it works', 'steve')").run();
});

/** A finished session-path review of `sha` with this verdict. */
function reviewed(verdict: 'ship' | 'revise' | 'escalate' | null, finishedAt: number, opts: { round?: number; sha?: string; prNumber?: number } = {}): void {
  const id = startEvaluatorRun(db, { ticketId: 705, prNumber: opts.prNumber ?? 500, round: opts.round ?? 1, model: 'm', lens: 'code', headSha: opts.sha ?? SHA }, finishedAt - 1000);
  finishEvaluatorRun(
    db,
    id,
    verdict ? { report: { verdict, summary: 'Bug.', findings: [] }, turns: 1, tokens: 1 } : { error: 'boom', turns: 1, tokens: 1 },
    finishedAt,
  );
}

const ticket = () =>
  db.prepare('SELECT assignee, status, agent_state AS agentState FROM agent_tickets WHERE id = 705').get() as { assignee: string; status: string; agentState: string | null };
const events = (type: string) => db.prepare('SELECT detail FROM agent_ticket_events WHERE ticket_id = 705 AND type = ?').all(type) as { detail: string }[];

function passDeps(list: OtherPr[] = [pr()]) {
  const comments: string[] = [];
  return { comments, d: { listPrs: async () => list, comment: async (_r: string, _n: number, b: string) => void comments.push(b) } };
}

describe('adoption rules (PD-913)', () => {
  it('reads the ticket from a session branch only', () => {
    expect(branchDisplayId('pd-913-adopt')).toBe('PD-913');
    expect(branchDisplayId('PD-7')).toBe('PD-7');
    expect(branchDisplayId('feature/pd-913')).toBeNull();
    expect(adoptableTicket(db, 'robot/t705')).toBeNull();
  });

  it('adopts only a ticket the dispatch would pick up', () => {
    expect(adoptableTicket(db, 'pd-705-thing')?.id).toBe(705);
    const cases: [string, string][] = [
      ["status = 'completed'", 'terminal'],
      ["status = 'closed'", 'terminal'],
      ['refined = 0', 'unrefined'],
      ['ready = 0', 'not ready'],
      ['archived_at = 1', 'archived'],
      ["assignee = 'robot', agent_state = 'stuck'", 'the Robot already holds it'],
    ];
    for (const [set] of cases) {
      db.exec("UPDATE agent_tickets SET status = 'queue', refined = 1, ready = 1, archived_at = NULL, assignee = 'steve', agent_state = NULL WHERE id = 705");
      db.exec(`UPDATE agent_tickets SET ${set} WHERE id = 705`);
      expect(adoptableTicket(db, 'pd-705-thing'), set).toBeNull();
    }
  });

  it('does not adopt a blocked ticket or one in a project the Robot is off for', () => {
    db.prepare("INSERT INTO agent_tickets (id, display_id, title) VALUES (9, 'PD-9', 'Blocker')").run();
    db.prepare("INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type) VALUES (9, 705, 'blocks')").run();
    expect(adoptableTicket(db, 'pd-705-thing')).toBeNull();
    db.exec('DELETE FROM agent_ticket_relations; UPDATE agent_projects SET robot_enabled = 0');
    expect(adoptableTicket(db, 'pd-705-thing')).toBeNull();
  });

  it('combines every lens of a head, and waits while one is still running', () => {
    reviewed('ship', 1000);
    const sec = startEvaluatorRun(db, { ticketId: 705, prNumber: 500, round: 1, model: 'm', lens: 'security', headSha: SHA }, 900);
    expect(headVerdict(db, 500, SHA)).toBeNull();
    finishEvaluatorRun(db, sec, { report: { verdict: 'revise', summary: '', findings: [] }, turns: 1, tokens: 1 }, 2000);
    expect(headVerdict(db, 500, SHA)).toEqual({ verdict: 'revise', round: 1, finishedAt: 2000 });
  });
});

describe('runAdoptionPass (PD-913)', () => {
  it('adopts a revised session PR once it has been idle for the window, and comments on it', async () => {
    reviewed('revise', 0);
    const h = passDeps();
    expect(await runAdoptionPass(db, cfg(), 29 * MIN, h.d)).toEqual({ adopted: 0, released: 0 }); // too soon
    expect(await runAdoptionPass(db, cfg(), 30 * MIN, h.d)).toEqual({ adopted: 1, released: 0 });
    expect(ticket()).toEqual({ assignee: 'robot', status: 'queue', agentState: 'queued' });
    expect(JSON.parse(events(ROBOT_EVENT.adopted)[0].detail)).toEqual({ prNumber: 500, branch: 'pd-705-thing', headSha: SHA });
    expect(h.comments[0]).toMatch(/Robot is taking over the rework\*\* for PD-705 \(Do the thing\)/);
    expect(adoptedFrom(db, 705)).toEqual({ prNumber: 500, branch: 'pd-705-thing' });
    // A rework in the form the PD-924 dispatch guard and PD-926 supersede watch recognise, but not an
    // "evaluator requested changes" one, which PD-924 could send back to an in-review it never had.
    const re = JSON.parse(events(ROBOT_EVENT.reactivated)[0].detail);
    expect(re.prNumber).toBe(500);
    expect(re.reason).not.toMatch(/^evaluator requested changes/);
  });

  it('does not adopt a ship, an escalate, a failed review, or a revise at the round cap', async () => {
    for (const [verdict, round] of [['ship', 1], ['escalate', 1], [null, 1], ['revise', 2]] as const) {
      db.exec('DELETE FROM evaluator_runs');
      reviewed(verdict, 0, { round });
      expect((await runAdoptionPass(db, cfg(), 60 * MIN, passDeps().d)).adopted, `${verdict} r${round}`).toBe(0);
    }
  });

  it('does not adopt a PR whose branch names no ticket, a draft, or with adoption off', async () => {
    reviewed('revise', 0);
    expect((await runAdoptionPass(db, cfg(), 60 * MIN, passDeps([pr({ headRefName: 'misc' })]).d)).adopted).toBe(0);
    expect((await runAdoptionPass(db, cfg(), 60 * MIN, passDeps([pr({ isDraft: true })]).d)).adopted).toBe(0);
    expect((await runAdoptionPass(db, cfg({ adopt: false }), 60 * MIN, passDeps().d)).adopted).toBe(0);
  });

  it('a push restarts the clock: the new head has no finished review to adopt on', async () => {
    reviewed('revise', 0);
    const moved = pr({ headRefOid: 'b'.repeat(40) });
    expect((await runAdoptionPass(db, cfg(), 60 * MIN, passDeps([moved]).d)).adopted).toBe(0);
  });

  it('releases an adoption back to Steve when he pushes before the Robot starts', async () => {
    reviewed('revise', 0);
    await runAdoptionPass(db, cfg(), 30 * MIN, passDeps().d);
    expect(pendingAdoptions(db)).toHaveLength(1);
    const out = await runAdoptionPass(db, cfg(), 31 * MIN, passDeps([pr({ headRefOid: 'b'.repeat(40) })]).d);
    expect(out.released).toBe(1);
    expect(ticket()).toEqual({ assignee: 'steve', status: 'queue', agentState: null });
    expect(JSON.parse(events(ROBOT_EVENT.released)[0].detail).reason).toBe('you pushed to it before the Robot started');
    expect(adoptedFrom(db, 705)).toBeNull();
    const n = db.prepare("SELECT title FROM agent_notifications WHERE kind = 'agent_needs_human'").all();
    expect(n).toEqual([{ title: 'PR #500 is back with you' }]);
  });

  it('releases when the PR closes before the Robot starts', async () => {
    reviewed('revise', 0);
    await runAdoptionPass(db, cfg(), 30 * MIN, passDeps().d);
    expect((await runAdoptionPass(db, cfg(), 31 * MIN, passDeps([]).d)).released).toBe(1);
  });

  it('leaves a started adoption alone: after a dispatch the branch is the Robot’s', async () => {
    reviewed('revise', 0);
    await runAdoptionPass(db, cfg(), 30 * MIN, passDeps().d);
    logMilestone(db, 705, ROBOT_EVENT.dispatched, { branch: 'pd-705-thing' }, 31 * MIN);
    expect(pendingAdoptions(db)).toEqual([]);
    expect((await runAdoptionPass(db, cfg(), 32 * MIN, passDeps([pr({ headRefOid: 'b'.repeat(40) })]).d)).released).toBe(0);
  });
});

describe('an adopted PR in the rest of the loop (PD-913)', () => {
  async function adopt(): Promise<void> {
    reviewed('revise', 0);
    await runAdoptionPass(db, cfg(), 30 * MIN, passDeps().d);
  }

  it('the dispatch keeps the clone of the adopted branch, not robot/t<id>', async () => {
    await adopt();
    expect(robotClaimedBranches(db)).toEqual(['pd-705-thing']);
  });

  it('the session-PR review path and the conflict resolver both leave it to the Robot', async () => {
    await adopt();
    expect(adoptedPrNumbers(db)).toEqual(new Set([500]));
    const moved = pr({ headRefOid: 'c'.repeat(40) });
    const out = await evaluateNextOtherPr(db, cfg(), 40 * MIN, {
      listPrs: async () => [moved],
      fetchHeadSha: async () => moved.headRefOid,
      fetchDiff: async () => 'diff',
      buildContext: () => 'ctx',
      runAgent: async () => ({ text: '{"verdict":"ship","summary":"","findings":[]}', ok: true, turns: 1, tokens: 1 }),
      comment: async () => undefined,
      postStatus: async () => true,
      readStatus: async (): Promise<StatusRead> => ({ ok: true, current: null }),
    });
    expect(out).toBeUndefined();
    const conflicted = { number: 500, headRefName: 'pd-705-thing', headRefOid: SHA, baseRefName: 'main', isCrossRepository: false, mergeable: 'CONFLICTING' };
    expect(nextConflictedPr(db, [conflicted] as unknown as Parameters<typeof nextConflictedPr>[1])).toBeNull();
  });

  it('a revise the Robot will adopt says so and raises no needs-human; one it will not, alerts', async () => {
    const revise = JSON.stringify({ verdict: 'revise', summary: 'Bug.', findings: [{ kind: 'correctness', blocking: true, where: 'a.ts:1', what: 'off by one' }] });
    const run = async (head: OtherPr) => {
      const descriptions: string[] = [];
      const comments: string[] = [];
      await evaluateNextOtherPr(db, cfg(), 1000, {
        listPrs: async () => [head],
        fetchHeadSha: async () => head.headRefOid,
        fetchDiff: async () => 'diff',
        buildContext: () => 'ctx',
        runAgent: async () => ({ text: revise, ok: true, turns: 1, tokens: 1 }),
        comment: async (_r, _n, b) => void comments.push(b),
        postStatus: async (_r, _s, st) => (descriptions.push(st.description), true),
        readStatus: async (): Promise<StatusRead> => ({ ok: true, current: null }),
      });
      return { descriptions, comments };
    };
    const adoptable = await run(pr());
    expect(adoptable.descriptions.at(-1)).toBe('Evaluator requested changes (round 1); Robot takes over after 30 min idle');
    expect(adoptable.comments[0]).toContain('the Robot takes over the rework');
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_notifications").get()).toEqual({ n: 0 });

    const noTicket = await run(pr({ number: 501, headRefName: 'misc', headRefOid: 'd'.repeat(40) }));
    expect(noTicket.descriptions.at(-1)).toBe('Evaluator requested changes (round 1); push a fix');
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_notifications").get()).toEqual({ n: 1 });
  });

  it('the prompt tells the Robot it is Steve’s branch and never to force-push', () => {
    const prompt = buildTaskPrompt({
      title: 'Do the thing', body: null, branch: 'pd-705-thing', repo: 'r/r', displayId: 'PD-705', issueNumber: null, proxy: '',
      resume: { evaluatorBrief: 'fix it', adoptedFrom: { prNumber: 500 } },
    });
    expect(prompt).toContain('## This PR (#500) was opened by Steve, not by a Robot');
    expect(prompt).toContain('Never force-push, rebase or amend.');
    expect(prompt.indexOf('opened by Steve')).toBeLessThan(prompt.indexOf('An automated Evaluator reviewed your PR'));
    expect(buildTaskPrompt({ title: 't', body: null, branch: 'robot/t1', repo: 'r/r', displayId: 'PD-1', issueNumber: null, proxy: '' })).not.toContain('opened by Steve');
  });
});
