import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureEvaluatorRunsTable } from './evaluator-runs';
import { ensureRunsTable, finishRun, startRun } from '../robot/runs';
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
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT, agent_state TEXT, archived_at INTEGER);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
  `);
  ensureEvaluatorRunsTable(db);
  ensureRunsTable(db);
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, body) VALUES (705, 'PD-705', 'Do the thing', '## Done When\n- it works')").run();
});

/**
 * Make `ticketId` a current in-review Robot target for `prNumber` — the condition `inReviewPrTargets`
 * selects: status='queue', assignee='robot', agent_state='in-review', with a newest handed-off run
 * carrying the PR url.
 */
function seedInReviewTarget(ticketId: number, prNumber: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO agent_tickets (id, display_id, title, body, status, assignee, agent_state) VALUES (?, ?, 'In review', '## Done When\n- it works', 'queue', 'robot', 'in-review')",
  ).run(ticketId, `PD-${ticketId}`);
  const runId = startRun(db, { ticketId, issueNumber: prNumber, branch: `robot/t${ticketId}` }, 10);
  finishRun(db, runId, { status: 'handed-off', prUrl: `https://github.com/scolacur/personal-dashboard/pull/${prNumber}` }, 100);
}

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
  const none = new Set<number>();

  it('skips forks, drafts, other bases, the skip label and MEMORY-only PRs', () => {
    expect(skipReason(pr(), none)).toBeNull();
    expect(skipReason(pr({ isCrossRepository: true }), none)).toMatch(/fork/);
    expect(skipReason(pr({ isDraft: true }), none)).toMatch(/draft/);
    expect(skipReason(pr({ baseRefName: 'release' }), none)).toMatch(/main/);
    expect(skipReason(pr({ labels: [{ name: 'skip-evaluator' }] }), none)).toMatch(/skip-evaluator/);
    expect(skipReason(pr({ files: [{ path: 'MEMORY/runs/x.md' }] }), none)).toMatch(/MEMORY/);
    expect(skipReason(pr({ files: [{ path: 'MEMORY/runs/x.md' }, { path: 'DECISIONS/D-1.md' }] }), none)).toBeNull();
  });

  it('skips a robot/* PR only when its number is a current in-review Robot target (PD-825)', () => {
    // In-review: the Robot path owns it, so this path skips it.
    expect(skipReason(pr({ headRefName: 'robot/t1' }), new Set([500]))).toMatch(/robot/);
    // Not in-review (hand-finished on its own branch, reassigned, stuck, …): reviewed here.
    expect(skipReason(pr({ headRefName: 'robot/t1' }), none)).toBeNull();
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

  it('honours a configured round cap above the default (PD-761)', async () => {
    // With EVALUATOR_MAX_ROUNDS=3, a third head is still reviewed where the default cap of 2 stops.
    const h = deps(revise);
    const c = cfg({ maxRounds: 3 });
    await evaluateNextOtherPr(db, c, 1000, h.d);
    const second = { ...h.d, listPrs: async () => [pr({ headRefOid: 'b'.repeat(40) })], fetchHeadSha: async () => 'b'.repeat(40) };
    expect((await evaluateNextOtherPr(db, c, 2000, second))?.verdict).toBe('revise');
    const third = { ...h.d, listPrs: async () => [pr({ headRefOid: 'c'.repeat(40) })], fetchHeadSha: async () => 'c'.repeat(40) };
    expect((await evaluateNextOtherPr(db, c, 3000, third))?.verdict).toBe('revise'); // 3rd round allowed
    const fourth = { ...h.d, listPrs: async () => [pr({ headRefOid: 'd'.repeat(40) })], fetchHeadSha: async () => 'd'.repeat(40) };
    expect(await evaluateNextOtherPr(db, c, 4000, fourth)).toBeUndefined(); // 3 rounds used
    expect(h.runAgent).toHaveBeenCalledTimes(3);
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

  it('skips a robot/* PR whose ticket IS in-review (the Robot path owns it) (PD-825)', async () => {
    seedInReviewTarget(977, 463);
    const h = deps(ship, [pr({ number: 463, headRefName: 'robot/t977', title: 'feat: thing', body: '**Ticket:** PD-977' })]);
    const out = await evaluateNextOtherPr(db, cfg(), 1000, h.d);
    expect(out).toBeUndefined(); // nothing left to review on this path
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.comments).toEqual([]);
    expect(h.statuses).toEqual([]);
  });

  it('reviews a robot/* PR whose ticket is NOT in-review and ships review-gate success (PD-825)', async () => {
    // Its ticket exists but sits at queue/steve — not an in-review Robot target — so the Robot path
    // never sees it. The all-PRs path reviews it and a ship opens review-gate.
    db.prepare(
      "INSERT INTO agent_tickets (id, display_id, title, body, status, assignee, agent_state) VALUES (977, 'PD-977', 'Finish by hand', '## Done When\n- done', 'queue', 'steve', 'queued')",
    ).run();
    const robotPr = pr({ number: 463, headRefName: 'robot/t977', title: 'feat: thing', body: '**Ticket:** PD-977' });
    const h = deps(ship, [robotPr]);
    const out = await evaluateNextOtherPr(db, cfg(), 1000, { ...h.d, fetchHeadSha: async () => robotPr.headRefOid });
    expect(out?.verdict).toBe('ship');
    expect(h.statuses).toEqual([{ sha: SHA, state: 'success' }]);
    expect(h.comments[0]).toMatch(/Evaluator \(round 1\): ship\*\*, judged against PD-977 \(Finish by hand\)/);
  });

  it('reviews a robot/* PR with no matching ticket, judged without acceptance criteria (PD-825)', async () => {
    const robotPr = pr({ number: 463, headRefName: 'robot/t999', title: 'tidy', body: 'No ticket.' });
    const h = deps(ship, [robotPr]);
    const out = await evaluateNextOtherPr(db, cfg(), 1000, { ...h.d, fetchHeadSha: async () => robotPr.headRefOid });
    expect(out?.verdict).toBe('ship');
    expect(h.runAgent.mock.calls[0][2]).toMatch(/NO LINKED TICKET/);
    expect(h.statuses).toEqual([{ sha: SHA, state: 'success' }]);
    expect(h.comments[0]).toMatch(/no linked ticket, so no acceptance criteria/);
  });
});

describe('evaluateNextOtherPr: per-head one-retry + diagnostics + terminal notification (PD-884)', () => {
  const secShip = JSON.stringify({ verdict: 'ship', summary: 'security ship', findings: [] });

  /** An agent that answers per lens (the security prompt self-identifies) and records which it saw. */
  function lensDeps(answers: { code: string; security: string }, list: OtherPr[] = [pr()]) {
    const comments: string[] = [];
    const statuses: { sha: string; state: string }[] = [];
    const calls: string[] = [];
    const runAgent = vi.fn(async (_c: unknown, system: string): Promise<EvaluatorTurnResult> => {
      const lens = system.includes('the security reviewer') ? 'security' : 'code';
      calls.push(lens);
      return { text: lens === 'security' ? answers.security : answers.code, ok: true, turns: 3, tokens: 100 };
    });
    return {
      comments,
      statuses,
      calls,
      runAgent,
      d: {
        listPrs: async () => list,
        fetchHeadSha: async () => list[0]?.headRefOid ?? SHA,
        fetchDiff: async () => 'diff',
        buildContext: () => 'ctx',
        runAgent,
        comment: async (_r: string, _n: number, body: string) => void comments.push(body),
        postStatus: async (_r: string, sha: string, s: { state: string }) => (statuses.push({ sha, state: s.state }), true),
      },
    };
  }

  const needsHuman = () =>
    db.prepare("SELECT title, body FROM agent_notifications WHERE kind = 'agent_needs_human'").all() as { title: string; body: string }[];

  it('re-runs ONLY the errored security lens next pass; its ship folds the code ship into review-gate success', async () => {
    const c = cfg({ securityEnabled: true });
    // Pass 1: code ships, the security reviewer returns garbage → no verdict, retry pending.
    const h1 = lensDeps({ code: ship, security: 'not json' });
    const out1 = await evaluateNextOtherPr(db, c, 1000, h1.d);
    expect(h1.calls).toEqual(['code', 'security']);
    expect(out1).toBeNull(); // any missing verdict → no full ship
    expect(h1.statuses).toEqual([]); // nothing posted on a non-ship
    expect(needsHuman()).toHaveLength(0); // retry still pending

    // Pass 2: ONLY security re-runs (code already shipped this head); its ship combines with the
    // folded code ship to open review-gate.
    const h2 = lensDeps({ code: ship, security: secShip });
    const out2 = await evaluateNextOtherPr(db, c, 2000, h2.d);
    expect(h2.calls).toEqual(['security']);
    expect(out2?.verdict).toBe('ship');
    expect(h2.statuses).toEqual([{ sha: SHA, state: 'success' }]);
  });

  it('a second security error leaves the gate to Steve, does not run a third time, and notifies once naming security', async () => {
    const c = cfg({ securityEnabled: true });
    await evaluateNextOtherPr(db, c, 1000, lensDeps({ code: ship, security: 'nope' }).d); // security error #1
    expect(needsHuman()).toHaveLength(0);

    const h2 = lensDeps({ code: ship, security: 'still nope' });
    const out2 = await evaluateNextOtherPr(db, c, 2000, h2.d); // security error #2 (retry used)
    expect(h2.calls).toEqual(['security']);
    expect(out2).toBeNull();
    expect(h2.statuses).toEqual([]); // no success posted — left to Steve
    const notifs = needsHuman();
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toContain('PR #500');
    expect(notifs[0].body).toContain('security');

    // Third pass: the head is settled — no third security run, and still exactly one notification.
    const h3 = lensDeps({ code: ship, security: secShip });
    const out3 = await evaluateNextOtherPr(db, c, 3000, h3.d);
    expect(out3).toBeUndefined();
    expect(h3.calls).toEqual([]);
    expect(needsHuman()).toHaveLength(1);
  });

  it('a new head_sha resets the retry — the new head is reviewed fresh', async () => {
    const c = cfg({ securityEnabled: true });
    // Exhaust the security retry on head A.
    await evaluateNextOtherPr(db, c, 1000, lensDeps({ code: ship, security: 'nope' }).d);
    await evaluateNextOtherPr(db, c, 2000, lensDeps({ code: ship, security: 'nope' }).d);
    // A new push is a fresh review: both lenses run again, and a full ship opens the gate on head B.
    const headB = 'b'.repeat(40);
    const h = lensDeps({ code: ship, security: secShip }, [pr({ headRefOid: headB })]);
    const out = await evaluateNextOtherPr(db, c, 3000, h.d);
    expect(h.calls).toEqual(['code', 'security']);
    expect(out?.verdict).toBe('ship');
    expect(h.statuses).toEqual([{ sha: headB, state: 'success' }]);
  });

  it('stores the full unparseable reply up to the 20k cap, not a 500-char head', async () => {
    const long = `${'x'.repeat(30_000)} no-json-here`; // no JSON object → unparseable
    await evaluateNextOtherPr(db, cfg(), 1000, deps(long).d);
    const err =
      (db.prepare('SELECT error FROM evaluator_runs WHERE pr_number = 500 ORDER BY id DESC LIMIT 1').get() as { error: string | null }).error ?? '';
    expect(err).toMatch(/unparseable/);
    expect(err.length).toBeGreaterThan(500); // not the old 500-char slice
    expect(err.length).toBeLessThanOrEqual(20_100); // bounded by the ~20k cap (+ short prefix)
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
    expect(verdictComment(null, 1, [], 2)).toMatch(/no usable verdict/);
  });

  it('states the configured round cap in the revise text (PD-761)', () => {
    const report = { verdict: 'revise' as const, summary: 'Needs work.', findings: [] };
    expect(verdictComment(report, 1, [], 2)).toContain('up to 2 rounds');
    expect(verdictComment(report, 1, [], 5)).toContain('up to 5 rounds');
  });
});
