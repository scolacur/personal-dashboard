import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config';
import { ensureRunsTable, finishRun, startRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import { reviewBoundary } from '../evaluate/evaluate';
import { runConflictPass, type OpenPr } from './pass';
import type { ResolveOutcome } from './resolve';

const cfg = () => loadConfig({ CONFLICT_RESOLVER_ENABLED: '1', CONFLICT_RESOLVER_INTERVAL_MS: '0' });

const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  number: 314,
  headRefName: 'robot/220',
  headRefOid: 'aaa',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  isCrossRepository: false,
  url: 'https://github.com/scolacur/personal-dashboard/pull/314',
  ...over,
});

const resolved: ResolveOutcome = {
  kind: 'resolved',
  mergeSha: 'bbb',
  files: [{ kind: 'union', path: 'packages/shared/src/index.ts', content: '' }],
};
const refused: ResolveOutcome = { kind: 'refused', reason: 'app.ts: both sides changed the same lines', files: [] };

describe('runConflictPass (PD-774)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
    `);
    ensureRunsTable(db);
    ensureRobotStateTable(db);
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, assignee, agent_state) VALUES (1, 'PD-1', 'Do the thing', 'queue', 'robot', 'in-review')").run();
    const runId = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/220' }, 10);
    finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 100);
  });

  const state = () => (db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = 1').get() as { s: string }).s;
  const types = () => (db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1').all() as { type: string }[]).map((r) => r.type);

  it('is inert when disabled', async () => {
    let listed = false;
    const out = await runConflictPass(db, loadConfig({}), 5000, { listOpenPrs: async () => ((listed = true), []) });
    expect(out).toBeNull();
    expect(listed).toBe(false);
  });

  it('resolves a Robot PR, comments, and opens a new review boundary for the Evaluator', async () => {
    let commented = false;
    const out = await runConflictPass(db, cfg(), 5000, {
      listOpenPrs: async () => [pr()],
      resolve: async () => resolved,
      comment: async () => void (commented = true),
    });
    expect(out).toBe('resolved');
    expect(commented).toBe(true);
    expect(state()).toBe('in-review');
    expect(types()).toContain('robot_conflict_resolved');
    expect(reviewBoundary(db, 1)).toBe(5000);
  });

  it('hands an unresolvable Robot PR back to the Robot, as before', async () => {
    const out = await runConflictPass(db, cfg(), 5000, { listOpenPrs: async () => [pr()], resolve: async () => refused });
    expect(out).toBe('refused');
    expect(state()).toBe('queued');
    expect(types()).toContain('robot_reactivated');
  });

  it("notifies Steve about anyone else's PR it cannot resolve", async () => {
    const out = await runConflictPass(db, cfg(), 5000, {
      listOpenPrs: async () => [pr({ number: 500, headRefName: 'pd-9-thing' })],
      resolve: async () => refused,
    });
    expect(out).toBe('refused');
    const n = db.prepare('SELECT title, body FROM agent_notifications').get() as { title: string; body: string };
    expect(n.title).toBe('PR #500 conflicts with main');
    expect(n.body).toMatch(/both sides changed the same lines/);
  });

  it('tries one head once, retries a new head, and gives up on a head after three errors', async () => {
    let calls = 0;
    const deps = { listOpenPrs: async () => [pr({ number: 500, headRefName: 'pd-9' })], resolve: async () => (calls++, refused) };
    await runConflictPass(db, cfg(), 5000, deps);
    expect(await runConflictPass(db, cfg(), 6000, deps)).toBeNull();
    expect(calls).toBe(1);

    const err: ResolveOutcome = { kind: 'error', reason: 'clone failed' };
    const errDeps = { listOpenPrs: async () => [pr({ number: 501, headRefName: 'pd-10' })], resolve: async () => (calls++, err) };
    for (let t = 7000; t < 12000; t += 1000) await runConflictPass(db, cfg(), t, errDeps);
    expect(calls).toBe(4); // 1 + three error attempts, then settled
  });

  it('skips non-conflicting PRs, other bases, forks, and Robot PRs not in review', async () => {
    let calls = 0;
    const out = await runConflictPass(db, cfg(), 5000, {
      listOpenPrs: async () => [
        pr({ number: 1, mergeable: 'MERGEABLE', headRefName: 'a' }),
        pr({ number: 2, baseRefName: 'release', headRefName: 'b' }),
        pr({ number: 3, isCrossRepository: true, headRefName: 'c' }),
        pr({ number: 4, headRefName: 'robot/999' }),
      ],
      resolve: async () => (calls++, resolved),
    });
    expect(out).toBeNull();
    expect(calls).toBe(0);
  });
});
