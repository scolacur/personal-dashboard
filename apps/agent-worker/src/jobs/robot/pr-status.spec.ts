import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROBOT_EVENT } from '@dashboard/shared';
import { loadConfig } from '../../shared/config';
import { ensureRunsTable, finishRun, startRun } from './runs';
import { ensureRobotStateTable } from './state';
import {
  STATUS_START,
  STATUS_END,
  currentState,
  renderStatusBlock,
  runPrStatusUpdate,
  upsertStatusBlock,
  type StatusEvent,
} from './pr-status';

const base = (over: StatusEvent[]): {
  ticketId: number;
  displayId: string;
  title: string;
  ticketUrl: string;
  events: StatusEvent[];
  now: number;
} => ({
  ticketId: 1,
  displayId: 'PD-901',
  title: 'Live PR status block',
  ticketUrl: 'http://nas:8088/devops/tickets/PD-901',
  events: over,
  now: 10_000,
});

const ev = (type: string, detail: Record<string, unknown>, createdAt: number): StatusEvent => ({ type, detail, createdAt });

describe('renderStatusBlock / currentState (PD-901)', () => {
  it('a ticket mid-review: round 1, code shipped, security reviewing', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.handoff, {}, 2000),
      ev(ROBOT_EVENT.evaluating, { round: 1, lens: 'code' }, 3000),
      ev(ROBOT_EVENT.evaluated, { round: 1, lens: 'code', verdict: 'ship', findings: 1, blockingFindings: 0, reason: 'LGTM\nmore' }, 4000),
      ev(ROBOT_EVENT.evaluating, { round: 1, lens: 'security' }, 5000),
    ]);
    expect(currentState(input).line).toBe('Evaluator reviewing — round 1 (code ✓ ship, security … reviewing)');
    const md = renderStatusBlock(input);
    expect(md.startsWith(STATUS_START)).toBe(true);
    expect(md.endsWith(STATUS_END)).toBe(true);
    expect(md).toContain('[PD-901 — Live PR status block](http://nas:8088/devops/tickets/PD-901)');
    expect(md).toContain('| 1 | ✓ ship (0/1) | … reviewing | LGTM |');
    expect(md).toContain('#### History');
  });

  it('a revise → rework → round 2 ship', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.handoff, {}, 2000),
      ev(ROBOT_EVENT.evaluating, { round: 1, lens: 'code' }, 3000),
      ev(ROBOT_EVENT.evaluated, { round: 1, lens: 'code', verdict: 'revise', findings: 3, blockingFindings: 2, reason: 'fix the thing' }, 4000),
      ev(ROBOT_EVENT.reactivated, { reason: 'evaluator requested changes (round 1)' }, 5000),
      ev(ROBOT_EVENT.dispatched, {}, 6000),
      ev(ROBOT_EVENT.handoff, {}, 7000),
      ev(ROBOT_EVENT.evaluating, { round: 2, lens: 'code' }, 8000),
      ev(ROBOT_EVENT.evaluated, { round: 2, lens: 'code', verdict: 'ship', findings: 0, blockingFindings: 0 }, 9000),
    ]);
    expect(currentState(input).line).toBe('Ready to merge: code shipped');
    const md = renderStatusBlock(input);
    expect(md).toContain('| 1 | ✗ revise (2/3) | fix the thing |');
    expect(md).toContain('| 2 | ✓ ship (0/0) | — |');
    expect(md).toContain('Re-queued for rework — evaluator requested changes (round 1)');
  });

  it('a mid-rework working phase reads as reworking, not plain working', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.handoff, {}, 2000),
      ev(ROBOT_EVENT.reactivated, { reason: 'CHANGES_REQUESTED review from steve' }, 3000),
      ev(ROBOT_EVENT.dispatched, {}, 4000),
    ]);
    expect(currentState(input).line).toBe('Reworking: CHANGES_REQUESTED review from steve');
  });

  it('an ask_human park quotes the question on the state line', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.askHuman, { question: 'Should the badge be red or amber?\nSecond line ignored' }, 2000),
    ]);
    expect(currentState(input).line).toBe('Waiting on Steve: Should the badge be red or amber?');
    expect(renderStatusBlock(input)).toContain('Asked Steve — Should the badge be red or amber?');
  });

  it('a visual-check wait', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.handoff, {}, 2000),
      ev(ROBOT_EVENT.evaluated, { round: 1, lens: 'code', verdict: 'ship', findings: 0, blockingFindings: 0 }, 3000),
      ev(ROBOT_EVENT.visualReviewRequested, { by: 'evaluator' }, 4000),
    ]);
    expect(currentState(input).line).toBe("Waiting on Steve's visual check");
    expect(renderStatusBlock(input)).toContain('Visual check requested');
  });

  it('a completed ticket', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.handoff, {}, 2000),
      ev(ROBOT_EVENT.evaluated, { round: 1, lens: 'code', verdict: 'ship', findings: 0, blockingFindings: 0 }, 3000),
      ev(ROBOT_EVENT.completed, { prNumber: 5 }, 4000),
    ]);
    const s = currentState(input);
    expect(s.line).toBe('Merged ✓');
    expect(s.done).toBe(true);
    expect(renderStatusBlock(input)).toContain('PR merged');
  });

  it('both lenses ship reads as ready to merge', () => {
    const input = base([
      ev(ROBOT_EVENT.dispatched, {}, 1000),
      ev(ROBOT_EVENT.handoff, {}, 2000),
      ev(ROBOT_EVENT.evaluated, { round: 1, lens: 'code', verdict: 'ship', findings: 0, blockingFindings: 0 }, 3000),
      ev(ROBOT_EVENT.evaluated, { round: 1, lens: 'security', verdict: 'ship', findings: 0, blockingFindings: 0 }, 4000),
    ]);
    expect(currentState(input).line).toBe('Ready to merge: both lenses ship');
  });

  it('caps history at the last 10 entries', () => {
    const events: StatusEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(ev(ROBOT_EVENT.dispatched, {}, 1000 + i));
    const md = renderStatusBlock(base(events));
    const historyLines = md.split('\n').filter((l) => l.includes('— Dispatched'));
    expect(historyLines).toHaveLength(10);
  });
});

describe('upsertStatusBlock (PD-901)', () => {
  const block = `${STATUS_START}\nhello\n${STATUS_END}`;

  it('inserts the block at the top of a body without markers', () => {
    const out = upsertStatusBlock('**Ticket:** PD-901\n\nSummary here.', block);
    expect(out.startsWith(block)).toBe(true);
    expect(out).toContain('**Ticket:** PD-901');
  });

  it('inserts into an empty body as just the block', () => {
    expect(upsertStatusBlock('', block)).toBe(block);
  });

  it('replaces an existing block without touching the surrounding text', () => {
    const body = `before text\n\n${STATUS_START}\nOLD\n${STATUS_END}\n\nafter text`;
    const out = upsertStatusBlock(body, block);
    expect(out).toBe(`before text\n\n${block}\n\nafter text`);
    expect(out).not.toContain('OLD');
  });
});

describe('runPrStatusUpdate (PD-901)', () => {
  let db: Database.Database;
  const cfg = (over: Record<string, string> = {}) =>
    loadConfig({ ROBOT_GITHUB_TOKEN: 'w', GITHUB_READ_TOKEN: 'r', AGENT_WORKER_GITHUB_REPO: 'scolacur/personal-dashboard', DASHBOARD_PUBLIC_URL: 'http://nas:8088/', ...over });

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    `);
    ensureRunsTable(db);
    ensureRobotStateTable(db);
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, assignee, agent_state) VALUES (1, 'PD-901', 'Status block', 'queue', 'robot', 'in-review')").run();
    const runId = startRun(db, { ticketId: 1, issueNumber: null, branch: 'robot/t1' }, 10);
    finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/42' }, 100);
    const logEv = db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)');
    logEv.run(1, ROBOT_EVENT.dispatched, '{}', 1000);
    logEv.run(1, ROBOT_EVENT.handoff, '{}', 2000);
  });

  it('inserts the block into a PR body without markers', async () => {
    const edits: { body: string }[] = [];
    const n = await runPrStatusUpdate(db, cfg(), 5000, {
      readBody: async () => '**Ticket:** PD-901 — Status block\n\nOriginal summary.',
      writeBody: async (_r, _n, body) => (edits.push({ body }), true),
    });
    expect(n).toBe(1);
    expect(edits[0].body).toContain(STATUS_START);
    expect(edits[0].body).toContain('Original summary.');
    expect(edits[0].body.indexOf(STATUS_START)).toBe(0);
  });

  it('replaces an existing block without touching the text around it', async () => {
    const existing = `lead\n\n${STATUS_START}\nSTALE\n${STATUS_END}\n\ntail`;
    const edits: string[] = [];
    await runPrStatusUpdate(db, cfg(), 5000, {
      readBody: async () => existing,
      writeBody: async (_r, _n, body) => (edits.push(body), true),
    });
    expect(edits[0]).toContain('lead\n\n');
    expect(edits[0]).toContain('\n\ntail');
    expect(edits[0]).not.toContain('STALE');
  });

  it('skips the write when the rendered block is unchanged', async () => {
    const deps = {
      reads: 0,
      writes: 0,
    };
    const run1 = {
      readBody: async () => {
        deps.reads++;
        return '';
      },
      writeBody: async () => {
        deps.writes++;
        return true;
      },
    };
    // First pass writes once and records the hash.
    expect(await runPrStatusUpdate(db, cfg(), 5000, run1)).toBe(1);
    expect(deps.writes).toBe(1);
    // Second pass: timeline unchanged → hash matches → no read, no write.
    expect(await runPrStatusUpdate(db, cfg(), 6000, run1)).toBe(0);
    expect(deps.writes).toBe(1);
    expect(deps.reads).toBe(1);
  });

  it('re-renders after a new event changes the timeline', async () => {
    let writes = 0;
    const deps = { readBody: async () => '', writeBody: async () => (writes++, true) };
    await runPrStatusUpdate(db, cfg(), 5000, deps);
    expect(writes).toBe(1);
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      1,
      ROBOT_EVENT.evaluated,
      JSON.stringify({ round: 1, lens: 'code', verdict: 'ship', findings: 0, blockingFindings: 0 }),
      7000,
    );
    await runPrStatusUpdate(db, cfg(), 8000, deps);
    expect(writes).toBe(2);
  });

  it('does not write back when the body already carries the exact block, but records the hash', async () => {
    let reads = 0;
    let writes = 0;
    // Render once against an empty body to learn the block, then feed that same body back.
    const first = await runPrStatusUpdate(db, cfg(), 5000, {
      readBody: async () => '',
      writeBody: async () => true,
    });
    expect(first).toBe(1);
    // Wipe the stored hash so the second pass must read the body and reconcile.
    db.prepare("UPDATE robot_state SET value = 'stale' WHERE key = 'pr_status_hash:1'").run();
    const rendered = renderStatusBlock({
      ticketId: 1,
      displayId: 'PD-901',
      title: 'Status block',
      ticketUrl: 'http://nas:8088/devops/tickets/PD-901',
      events: [
        { type: ROBOT_EVENT.dispatched, detail: {}, createdAt: 1000 },
        { type: ROBOT_EVENT.handoff, detail: {}, createdAt: 2000 },
      ],
      now: 9000,
    });
    const n = await runPrStatusUpdate(db, cfg(), 9000, {
      readBody: async () => (reads++, rendered),
      writeBody: async () => (writes++, true),
    });
    expect(n).toBe(0); // body already correct → no edit
    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });

  it('skips tickets whose PR is in another repo', async () => {
    let writes = 0;
    const n = await runPrStatusUpdate(db, cfg({ AGENT_WORKER_GITHUB_REPO: 'someone/else' }), 5000, {
      readBody: async () => '',
      writeBody: async () => (writes++, true),
    });
    expect(n).toBe(0);
    expect(writes).toBe(0);
  });

  it('does not advance the hash when the GitHub read fails (retries next tick)', async () => {
    let writes = 0;
    const n = await runPrStatusUpdate(db, cfg(), 5000, {
      readBody: async () => null,
      writeBody: async () => (writes++, true),
    });
    expect(n).toBe(0);
    expect(writes).toBe(0);
    expect(db.prepare("SELECT value FROM robot_state WHERE key = 'pr_status_hash:1'").get()).toBeUndefined();
  });

  it('leaves a completed ticket PR alone', async () => {
    db.prepare("UPDATE agent_tickets SET status = 'completed' WHERE id = 1").run();
    let writes = 0;
    const n = await runPrStatusUpdate(db, cfg(), 5000, { readBody: async () => '', writeBody: async () => (writes++, true) });
    expect(n).toBe(0);
    expect(writes).toBe(0);
  });
});
