import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureEvaluatorRunsTable } from './evaluator-runs';
import type { EvaluatorTurnResult } from './evaluate-agent';
import { evaluateNextOtherPr, linkedTicket, skipReason, verdictComment, type OtherPr } from './all-prs';

const SHA = 'a'.repeat(40);
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

const ship = '{"verdict":"ship","summary":"Good.","findings":[]}';
const revise = JSON.stringify({
  verdict: 'revise',
  summary: `Bug. ${HUMAN_REPLY_MARKER}`,
  findings: [{ kind: 'correctness', blocking: true, where: 'a.ts:1', what: 'off by one | here' }],
});

function cfg(over: Partial<AgentWorkerConfig['evaluator']> = {}): AgentWorkerConfig {
  const base = loadConfig({ ROBOT_GITHUB_TOKEN: 'ghp_w' });
  return { ...base, evaluator: { ...base.evaluator, enabled: true, intervalMs: 0, securityEnabled: false, reviewGateToken: 'tok', ...over } };
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT, archived_at INTEGER);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  ensureEvaluatorRunsTable(db);
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, body) VALUES (705, 'PD-705', 'Do the thing', '## Done When\n- it works')").run();
});

function deps(reply: string, list: OtherPr[] = [pr()]) {
  const comments: string[] = [];
  const statuses: { sha: string; state: string }[] = [];
  const runAgent = vi.fn(async (_c: unknown, _s: string, _u: string): Promise<EvaluatorTurnResult> => ({ text: reply, ok: true, turns: 3, tokens: 100 }));
  return {
    comments,
    statuses,
    runAgent,
    d: {
      listPrs: async () => list,
      fetchHeadSha: async () => SHA,
      fetchDiff: async () => 'diff',
      buildContext: () => 'ctx',
      runAgent,
      comment: async (_r: string, _n: number, body: string) => void comments.push(body),
      postStatus: async (_r: string, sha: string, s: { state: string }) => (statuses.push({ sha, state: s.state }), true),
    },
  };
}

describe('skipReason / linkedTicket (PD-712)', () => {
  it('skips Robot, forks, drafts, other bases, the skip label and MEMORY-only PRs', () => {
    expect(skipReason(pr())).toBeNull();
    expect(skipReason(pr({ headRefName: 'robot/t1' }))).toMatch(/robot/);
    expect(skipReason(pr({ isCrossRepository: true }))).toMatch(/fork/);
    expect(skipReason(pr({ isDraft: true }))).toMatch(/draft/);
    expect(skipReason(pr({ baseRefName: 'release' }))).toMatch(/main/);
    expect(skipReason(pr({ labels: [{ name: 'skip-evaluator' }] }))).toMatch(/skip-evaluator/);
    expect(skipReason(pr({ files: [{ path: 'MEMORY/runs/x.md' }] }))).toMatch(/MEMORY/);
    expect(skipReason(pr({ files: [{ path: 'MEMORY/runs/x.md' }, { path: 'DECISIONS/D-1.md' }] }))).toBeNull();
  });

  it('links the ticket from the branch, then title or body, ignoring decisions and unknown ids', () => {
    expect(linkedTicket(db, pr())?.displayId).toBe('PD-705');
    expect(linkedTicket(db, pr({ headRefName: 'fix-x', title: 'D-098 and PD-705: thing' }))?.displayId).toBe('PD-705');
    expect(linkedTicket(db, pr({ headRefName: 'pd-9-x', title: 'nothing', body: '' }))).toBeNull();
  });
});

describe('evaluateNextOtherPr (PD-712)', () => {
  it('ships: comments, records on the ticket, and sets review-gate success on the reviewed head', async () => {
    const h = deps(ship);
    const out = await evaluateNextOtherPr(db, cfg(), 1000, h.d);
    expect(out?.verdict).toBe('ship');
    expect(h.statuses).toEqual([{ sha: SHA, state: 'success' }]);
    expect(h.comments[0]).toMatch(/Evaluator \(round 1\): ship\*\*, judged against PD-705 \(Do the thing\)/);
    const types = (db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 705').all() as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(['robot_evaluating', 'robot_evaluated']);
  });

  it('on revise posts no status (Steve decides), and the comment never carries the human-reply marker', async () => {
    const h = deps(revise);
    await evaluateNextOtherPr(db, cfg(), 1000, h.d);
    expect(h.statuses).toEqual([]);
    expect(h.comments[0]).not.toContain(HUMAN_REPLY_MARKER);
    expect(h.comments[0]).toContain('| blocking | a.ts:1 | off by one \\| here |');
  });

  it('reviews a PR with no ticket against its description, and says so', async () => {
    const h = deps(ship, [pr({ headRefName: 'misc', title: 'tidy', body: 'Tidies.' })]);
    await evaluateNextOtherPr(db, cfg(), 1000, h.d);
    expect(h.runAgent.mock.calls[0][2]).toMatch(/NO LINKED TICKET/);
    expect(h.comments[0]).toMatch(/no linked ticket, so no acceptance criteria/);
  });

  it('reviews each head once, re-reviews a new push, and stops at the round cap', async () => {
    const h = deps(revise);
    await evaluateNextOtherPr(db, cfg(), 1000, h.d);
    expect(await evaluateNextOtherPr(db, cfg(), 2000, h.d)).toBeUndefined(); // same head
    const second = { ...h.d, listPrs: async () => [pr({ headRefOid: 'b'.repeat(40) })], fetchHeadSha: async () => 'b'.repeat(40) };
    expect((await evaluateNextOtherPr(db, cfg(), 3000, second))?.verdict).toBe('revise');
    const third = { ...h.d, listPrs: async () => [pr({ headRefOid: 'c'.repeat(40) })], fetchHeadSha: async () => 'c'.repeat(40) };
    expect(await evaluateNextOtherPr(db, cfg(), 4000, third)).toBeUndefined(); // 2 rounds used
    expect(h.runAgent).toHaveBeenCalledTimes(2);
  });

  it('drops a review whose head moved before the diff was read, with no verdict and no status', async () => {
    const h = deps(ship);
    const out = await evaluateNextOtherPr(db, cfg(), 1000, { ...h.d, fetchHeadSha: async () => 'f'.repeat(40) });
    expect(out).toBeNull();
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.statuses).toEqual([]);
  });

  it('does not post review-gate without the statuses token', async () => {
    const h = deps(ship);
    await evaluateNextOtherPr(db, cfg({ reviewGateToken: '' }), 1000, h.d);
    expect(h.statuses).toEqual([]);
  });
});

describe('verdictComment', () => {
  it('says a failed review is neither ship nor revise', () => {
    expect(verdictComment(null, 1, null)).toMatch(/no usable verdict/);
  });
});
