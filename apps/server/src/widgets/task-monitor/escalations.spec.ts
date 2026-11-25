import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { OPEN_PRS_SNAPSHOT_KEY, type OpenPrsSnapshot } from '@dashboard/shared';
import { listAwaitingEscalation } from './escalations';

let db: Database.Database;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

const event = (ticket: number, type: string, detail: object, at: number) =>
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(ticket, type, JSON.stringify(detail), at);

interface RunInput {
  ticket?: number;
  pr: number;
  round?: number;
  verdict?: 'ship' | 'revise' | 'escalate' | null;
  lens?: 'code' | 'security';
  head?: string | null;
  at: number;
  finished?: number | null;
  error?: string | null;
  summary?: string;
  findings?: object[];
}
const evalRun = (r: RunInput) =>
  db
    .prepare(
      `INSERT INTO evaluator_runs (ticket_id, pr_number, round, verdict, findings, summary, lens, head_sha, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.ticket ?? 1,
      r.pr,
      r.round ?? 1,
      r.verdict ?? null,
      r.findings ? JSON.stringify(r.findings) : null,
      r.summary ?? null,
      r.lens ?? 'code',
      r.head ?? null,
      r.verdict === null || r.verdict === undefined ? (r.error ?? 'agent error') : null,
      r.at,
      r.finished === undefined ? r.at + 5 : r.finished,
    );

const snapshot = (prs: OpenPrsSnapshot['prs'], at: number, maxRounds = 2) =>
  db
    .prepare(
      `INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(OPEN_PRS_SNAPSHOT_KEY, JSON.stringify({ maxRounds, prs }), at);

const BLOCKING = { kind: 'ac-unmet', blocking: true, where: 'a.ts:1', what: 'Misses the second AC' };
const ADVISORY = { kind: 'readability', blocking: false, where: 'b.ts:2', what: 'Long line' };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, status TEXT NOT NULL DEFAULT 'queue', project_id INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, key TEXT, github_repo TEXT);
    INSERT INTO agent_projects (id, key, github_repo) VALUES (1, 'PD', 'x/y');
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE evaluator_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, pr_number INTEGER NOT NULL, round INTEGER NOT NULL,
      verdict TEXT, findings TEXT, summary TEXT, turns INTEGER, tokens INTEGER, model TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
      lens TEXT NOT NULL DEFAULT 'code', head_sha TEXT);
  `);
  // Ticket 1: a Robot ticket in review with PR #571.
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, assignee, agent_state) VALUES (1, 'PD-1', 'Cutover runbook', 'robot', 'in-review')").run();
  event(1, 'robot_handoff', { prUrl: 'https://github.com/x/y/pull/571' }, 100);
  // Ticket 2: a session ticket (Steve's), its PR #570 reviewed per head.
  db.prepare("INSERT INTO agent_tickets (id, display_id, title, assignee, agent_state) VALUES (2, 'PD-2', 'Re-refine recommendation', 'steve', NULL)").run();
});

describe('listAwaitingEscalation — Robot PRs (PD-1007)', () => {
  it('lists an escalate with its summary and only the blocking findings', () => {
    evalRun({ pr: 571, verdict: 'escalate', at: 200, summary: 'Absolute paths in the runbook.', findings: [BLOCKING, ADVISORY] });
    const [item] = listAwaitingEscalation(db);
    expect(item).toMatchObject({
      prNumber: 571,
      prUrl: 'https://github.com/x/y/pull/571',
      ticket: { id: 1, displayId: 'PD-1', title: 'Cutover runbook' },
      path: 'robot',
      reason: 'escalate',
      round: 1,
      escalatedAt: 205,
    });
    expect(item.lenses).toEqual([
      { lens: 'code', verdict: 'escalate', summary: 'Absolute paths in the runbook.', blockingFindings: [{ kind: 'ac-unmet', where: 'a.ts:1', what: 'Misses the second AC' }] },
    ]);
  });

  it('lists a revise at the round cap, and not a revise below it', () => {
    snapshot([{ number: 571, headSha: HEAD_A, approved: false }], 150, 2);
    evalRun({ pr: 571, verdict: 'revise', round: 1, at: 200, findings: [BLOCKING] });
    expect(listAwaitingEscalation(db)).toEqual([]);
    evalRun({ pr: 571, verdict: 'revise', round: 2, at: 300, findings: [BLOCKING] });
    // The snapshot predates the escalation, so it does not judge open/approved; the in-review ticket does.
    expect(listAwaitingEscalation(db)).toMatchObject([{ prNumber: 571, reason: 'round-cap', round: 2 }]);
  });

  it('lists no-verdict only once the lens has used its one retry', () => {
    evalRun({ pr: 571, verdict: null, at: 200 });
    expect(listAwaitingEscalation(db)).toEqual([]);
    evalRun({ pr: 571, verdict: null, at: 300 });
    const [item] = listAwaitingEscalation(db);
    expect(item).toMatchObject({ reason: 'no-verdict', lenses: [{ lens: 'code', verdict: null }] });
  });

  it('names no-verdict when one lens errored out even if the other escalated', () => {
    evalRun({ pr: 571, verdict: 'escalate', at: 200 });
    evalRun({ pr: 571, verdict: null, lens: 'security', at: 200 });
    evalRun({ pr: 571, verdict: null, lens: 'security', at: 300 });
    expect(listAwaitingEscalation(db)[0]).toMatchObject({ reason: 'no-verdict' });
    expect(listAwaitingEscalation(db)[0].lenses.map((l) => l.lens)).toEqual(['code', 'security']);
  });

  it('ignores a shipped cycle, a review still in flight, and interrupted runs', () => {
    evalRun({ pr: 571, verdict: 'ship', at: 200 });
    expect(listAwaitingEscalation(db)).toEqual([]);
    evalRun({ pr: 571, verdict: 'escalate', lens: 'security', at: 300, finished: null });
    expect(listAwaitingEscalation(db)).toEqual([]);
    db.prepare("UPDATE evaluator_runs SET error = 'interrupted: worker restart', finished_at = 400 WHERE finished_at IS NULL").run();
    expect(listAwaitingEscalation(db)).toEqual([]);
  });

  it('drops it once the PR merges (ticket leaves in-review or completes)', () => {
    evalRun({ pr: 571, verdict: 'escalate', at: 200 });
    db.prepare("UPDATE agent_tickets SET status = 'completed', agent_state = NULL WHERE id = 1").run();
    expect(listAwaitingEscalation(db)).toEqual([]);
  });

  it('drops it once the snapshot shows it closed or approved', () => {
    evalRun({ pr: 571, verdict: 'escalate', at: 200 });
    snapshot([{ number: 571, headSha: HEAD_A, approved: false }], 200);
    expect(listAwaitingEscalation(db)).toHaveLength(1);
    snapshot([{ number: 571, headSha: HEAD_A, approved: true }], 500);
    expect(listAwaitingEscalation(db)).toEqual([]);
    snapshot([], 600);
    expect(listAwaitingEscalation(db)).toEqual([]);
  });

  it('drops it when a new hand-off or conflict resolution starts a new cycle', () => {
    evalRun({ pr: 571, verdict: 'escalate', at: 200 });
    event(1, 'robot_conflict_resolved', {}, 300);
    expect(listAwaitingEscalation(db)).toEqual([]);
    evalRun({ pr: 571, verdict: 'escalate', at: 400 });
    expect(listAwaitingEscalation(db)).toHaveLength(1);
    event(1, 'robot_handoff', { prUrl: 'https://github.com/x/y/pull/571' }, 500);
    expect(listAwaitingEscalation(db)).toEqual([]);
  });

  it('returns nothing on a DB the worker never booted against', () => {
    db.exec('DROP TABLE evaluator_runs; DROP TABLE robot_state');
    expect(listAwaitingEscalation(db)).toEqual([]);
  });
});

describe('listAwaitingEscalation — session PRs (PD-1007)', () => {
  it('lists each reason on the current head of an open, unapproved PR', () => {
    evalRun({ ticket: 2, pr: 570, verdict: 'escalate', head: HEAD_A, at: 200, summary: 'Needs a product call.' });
    evalRun({ ticket: 0, pr: 580, verdict: 'revise', head: HEAD_A, round: 2, at: 210, findings: [BLOCKING] });
    evalRun({ ticket: 0, pr: 581, verdict: null, head: HEAD_A, at: 220 });
    evalRun({ ticket: 0, pr: 581, verdict: null, head: HEAD_A, at: 230 });
    evalRun({ ticket: 0, pr: 582, verdict: 'revise', head: HEAD_A, round: 1, at: 240 });
    snapshot(
      [570, 580, 581, 582].map((number) => ({ number, headSha: HEAD_A, approved: false })),
      250,
      2,
    );
    const items = listAwaitingEscalation(db);
    expect(items.map((i) => [i.prNumber, i.reason, i.path])).toEqual([
      [570, 'escalate', 'session'],
      [580, 'round-cap', 'session'],
      [581, 'no-verdict', 'session'],
    ]);
    expect(items[0]).toMatchObject({ ticket: { id: 2, displayId: 'PD-2' }, prUrl: 'https://github.com/x/y/pull/570' });
    expect(items[1].ticket).toBeNull();
    expect(items[1].prUrl).toBe('https://github.com/x/y/pull/580');
  });

  it('drops it when merged or closed (gone from the snapshot), approved, or a new head is pushed', () => {
    evalRun({ ticket: 2, pr: 570, verdict: 'escalate', head: HEAD_A, at: 200 });
    snapshot([{ number: 570, headSha: HEAD_A, approved: false }], 210);
    expect(listAwaitingEscalation(db)).toHaveLength(1);
    snapshot([{ number: 570, headSha: HEAD_A, approved: true }], 300);
    expect(listAwaitingEscalation(db)).toEqual([]);
    snapshot([{ number: 570, headSha: HEAD_B, approved: false }], 400);
    expect(listAwaitingEscalation(db)).toEqual([]);
    snapshot([], 500);
    expect(listAwaitingEscalation(db)).toEqual([]);
  });

  it('lists nothing for a session PR without a snapshot (open state unknown)', () => {
    evalRun({ ticket: 2, pr: 570, verdict: 'escalate', head: HEAD_A, at: 200 });
    expect(listAwaitingEscalation(db)).toEqual([]);
  });
});
