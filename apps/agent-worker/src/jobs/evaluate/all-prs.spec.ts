import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureEvaluatorRunsTable } from './evaluator-runs';
import type { EvaluatorTurnResult } from './evaluate-agent';
import { acceptanceBrief, evaluateNextOtherPr, linkedTickets, skipReason, verdictComment, type OtherPr } from './all-prs';

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

  const ids = (p: OtherPr) => linkedTickets(db, p).map((t) => t.displayId);

  it('links the ticket from the branch, then title or body, ignoring decisions and unknown ids', () => {
    expect(ids(pr())).toEqual(['PD-705']);
    expect(ids(pr({ headRefName: 'fix-x', title: 'D-098 and PD-705: thing' }))).toEqual(['PD-705']);
    expect(ids(pr({ headRefName: 'fix-x', title: 'tidy', body: 'Follows PD-705.' }))).toEqual(['PD-705']);
    expect(ids(pr({ headRefName: 'pd-9-x', title: 'nothing', body: '' }))).toEqual([]);
  });

  const seed = (...ns: number[]) => {
    for (const n of ns) db.prepare("INSERT INTO agent_tickets (id, display_id, title) VALUES (?, ?, 'T')").run(n, `PD-${n}`);
  };

  it('links every ticket the branch and title name, in order, once each (PD-804)', () => {
    seed(706, 707);
    expect(ids(pr({ headRefName: 'pd-706-x', title: 'Thing (PD-705, PD-706, PD-707)' }))).toEqual(['PD-706', 'PD-705', 'PD-707']);
  });

  it('does not read the body for tickets when the branch or title names one (PD-804)', () => {
    seed(706, 707);
    // Bodies cite related tickets for context — "partly covers PD-707" is not a claim to implement it.
    expect(ids(pr({ title: 'Thing (PD-706)', body: 'Partly covers PD-707.' }))).toEqual(['PD-705', 'PD-706']);
  });

  // PD-725: a Robot PR's branch is `robot/t<id>` (unmatchable) and its title may lack a (PD-n) suffix,
  // so linkage falls back to the first display id in the body — the deterministic `**Ticket:**` line
  // the task-prompt envelope now stamps there resolves the right ticket.
  it("links a Robot PR from the envelope's **Ticket:** body line when branch and title name none", () => {
    const p = pr({
      headRefName: 'robot/t887',
      title: 'feat: habit grid by day',
      body: '**Ticket:** PD-705 — Do the thing\n\n**Status:** DONE',
    });
    expect(ids(p)).toEqual(['PD-705']);
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

  it('judges a multi-ticket PR against every ticket, records on each, and names them all (PD-804)', async () => {
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, body) VALUES (706, 'PD-706', 'Remove the tabs', 'Out of scope: the modal — that is PD-705')").run();
    const h = deps(ship, [pr({ headRefName: 'pd-705-thing', title: 'Thing and tabs (PD-705, PD-706)', body: 'Related: PD-999.' })]);
    await evaluateNextOtherPr(db, cfg(), 1000, h.d);
    const prompt = h.runAgent.mock.calls[0][2];
    expect(prompt).toMatch(/MULTIPLE TICKETS/);
    expect(prompt).toContain('# PD-706 — Remove the tabs');
    expect(h.comments[0]).toMatch(/judged against PD-705 \(Do the thing\) and PD-706 \(Remove the tabs\)/);
    for (const id of [705, 706]) {
      const types = (db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = ?').all(id) as { type: string }[]).map((r) => r.type);
      expect(types).toEqual(['robot_evaluating', 'robot_evaluated']);
    }
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

describe('acceptanceBrief (PD-804)', () => {
  const t = (n: number) => ({ id: n, displayId: `PD-${n}`, title: `T${n}`, body: `body ${n}` });

  it('passes a single ticket through unchanged', () => {
    expect(acceptanceBrief([t(1)])).toEqual({ title: 'T1', body: 'body 1' });
  });

  it('frames several tickets as one change set, with every ticket’s criteria', () => {
    const b = acceptanceBrief([t(1), t(2)]);
    expect(b.title).toBe('PD-1: T1 + PD-2: T2');
    expect(b.body).toMatch(/^MULTIPLE TICKETS: this PR implements 2 tickets/);
    expect(b.body).toMatch(/defers work to another ticket in this list/);
    expect(b.body).toContain('# PD-1 — T1\n\nbody 1');
    expect(b.body).toContain('# PD-2 — T2\n\nbody 2');
  });
});

describe('verdictComment', () => {
  it('says a failed review is neither ship nor revise', () => {
    expect(verdictComment(null, 1, [])).toMatch(/no usable verdict/);
  });
});
