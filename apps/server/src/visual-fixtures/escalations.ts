import type Database from 'better-sqlite3';
import { OPEN_PRS_SNAPSHOT_KEY, ROBOT_EVENT, type OpenPrsSnapshot } from '@dashboard/shared';
import { createTicket, updateTicket } from '../widgets/task-monitor/store';

/**
 * Escalations fixture (PD-1007): one escalated PR per reason, so the Decisions page's Escalations
 * section has a card of each kind to photograph.
 *  - PR #571, a Robot hand-off the code review escalated;
 *  - PR #570, a session PR still revised at the round cap;
 *  - PR #572, a session PR with no linked ticket whose security review produced no verdict.
 *
 * `evaluator_runs` and `robot_state` are worker-owned and do not exist in the scratch database the
 * server boots, so they are created here with the worker's columns (`CREATE TABLE IF NOT EXISTS`,
 * which the worker's own bootstrap accepts).
 */

const HEAD_570 = '5'.repeat(40);
const HEAD_572 = '7'.repeat(40);
const MAX_ROUNDS = 2;

function ensureWorkerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluator_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, pr_number INTEGER NOT NULL,
      round INTEGER NOT NULL, verdict TEXT, findings TEXT, summary TEXT, turns INTEGER, tokens INTEGER,
      model TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
      lens TEXT NOT NULL DEFAULT 'code', head_sha TEXT
    );
    CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL);
  `);
}

export function escalationsIsEmpty(db: Database.Database): boolean {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evaluator_runs'").get();
  if (!exists) return true;
  return (db.prepare('SELECT COUNT(*) AS n FROM evaluator_runs').get() as { n: number }).n === 0;
}

function projectId(db: Database.Database): number {
  const row = db.prepare("SELECT id FROM agent_projects WHERE key = 'PD'").get() as { id: number } | undefined;
  if (!row) throw new Error('visual fixture: the PD project is missing (task-monitor schema not bootstrapped?)');
  return row.id;
}

export function seedEscalations(db: Database.Database, now: number): void {
  ensureWorkerTables(db);
  const pd = projectId(db);
  const hour = 3_600_000;
  const run = db.prepare(
    `INSERT INTO evaluator_runs (ticket_id, pr_number, round, verdict, findings, summary, model, error, started_at, finished_at, lens, head_sha)
     VALUES (?, ?, ?, ?, ?, ?, 'fixture', ?, ?, ?, ?, ?)`,
  );

  // A Robot ticket in review, handed off with PR #571, escalated by the code review.
  const robot = createTicket(db, { title: 'Cutover runbook uses absolute paths', projectId: pd, priority: 'P1', assignee: 'robot' });
  updateTicket(db, robot.id, { refined: true });
  updateTicket(db, robot.id, { status: 'queue' });
  db.prepare("UPDATE agent_tickets SET agent_state = 'in-review' WHERE id = ?").run(robot.id);
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    robot.id,
    ROBOT_EVENT.handoff,
    JSON.stringify({ prUrl: 'https://github.com/scolacur/personal-dashboard/pull/571' }),
    now - 5 * hour,
  );
  run.run(
    robot.id, 571, 1, 'escalate',
    JSON.stringify([
      { kind: 'ac-unmet', blocking: true, where: 'docs/cutover.md:12', what: 'The runbook hard-codes /Users/steve paths, so it only works on one machine.' },
      { kind: 'readability', blocking: false, where: 'docs/cutover.md:40', what: 'Step 7 repeats step 3.' },
    ]),
    'The runbook works, but whether it should assume one machine is a call for Steve, not a rework.',
    null, now - 4 * hour, now - 4 * hour + 60_000, 'code', null,
  );

  // A session PR still revised at the round cap.
  const session = createTicket(db, { title: 'A no-change re-refine may recommend Mark refined', projectId: pd, priority: 'P2', assignee: 'steve' });
  run.run(
    session.id, 570, MAX_ROUNDS, 'revise',
    JSON.stringify([
      { kind: 'test-gap', blocking: true, where: 'apps/server/src/refine.spec.ts', what: 'No spec covers a re-refine that changes nothing.' },
      { kind: 'correctness', blocking: true, where: 'apps/server/src/refine.ts:88', what: 'The recommendation ignores an open question round.' },
    ]),
    'Two blocking issues remain after the second round.',
    null, now - 2 * hour, now - 2 * hour + 60_000, 'code', HEAD_570,
  );

  // A session PR with no linked ticket: code shipped, security produced no verdict twice.
  run.run(0, 572, 1, 'ship', '[]', 'Small, focused change.', null, now - hour, now - hour + 30_000, 'code', HEAD_572);
  run.run(0, 572, 1, null, null, null, 'agent error', now - hour, now - hour + 30_000, 'security', HEAD_572);
  run.run(0, 572, 1, null, null, null, 'unparseable report: …', now - hour + 60_000, now - hour + 90_000, 'security', HEAD_572);

  const snapshot: OpenPrsSnapshot = {
    maxRounds: MAX_ROUNDS,
    prs: [
      { number: 570, headSha: HEAD_570, approved: false },
      { number: 571, headSha: '1'.repeat(40), approved: false },
      { number: 572, headSha: HEAD_572, approved: false },
    ],
  };
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OPEN_PRS_SNAPSHOT_KEY, JSON.stringify(snapshot), now);
}
