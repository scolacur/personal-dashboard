import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { processRobotQueue, branchFor, type RobotDeps } from './robot';
import { startRun, finishRun, listRunsForTicket, failedRunsForTicket, ensureRunsTable } from './runs';
import { isDispatchPaused } from './state';
import type { RobotSessionResult } from './session';

const READY = ['## Context', 'c', '## Task', 't', '## Done When', 'd', '## Out of scope', 'o'].join('\n');

function boardDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, github_repo TEXT, sortie_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL,
      project_id INTEGER, github_issue_number INTEGER, agent_state TEXT, archived_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_ticket_relations (id INTEGER PRIMARY KEY, from_ticket_id INTEGER, to_ticket_id INTEGER, type TEXT);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO agent_projects (id, github_repo, sortie_enabled) VALUES (1, ?, 1)').run('scolacur/personal-dashboard');
  ensureRunsTable(db);
  return db;
}

/** The milestone event types written for a ticket, oldest first (C3). */
function eventTypes(db: Database.Database, ticketId: number): string[] {
  return (
    db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = ? ORDER BY id ASC').all(ticketId) as {
      type: string;
    }[]
  ).map((r) => r.type);
}

function addQueued(db: Database.Database, id: number, issue: number | null = id): void {
  db.prepare(
    `INSERT INTO agent_tickets (id, title, body, status, project_id, github_issue_number, agent_state)
     VALUES (?, ?, ?, 'robot_queue', 1, ?, NULL)`,
  ).run(id, `T${id}`, READY, issue);
}

function agentState(db: Database.Database, id: number): string | null {
  return (db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = ?').get(id) as { s: string | null }).s;
}

const cfg = (over: Record<string, string> = {}): AgentWorkerConfig =>
  loadConfig({ ROBOT_DISPATCH_ENABLED: '1', ROBOT_ALLOWLIST: '1', ...over });

/** Backoff off so multi-cycle tests with a fixed clock are always retry-eligible. */
const cfgNoBackoff = (over: Record<string, string> = {}): AgentWorkerConfig =>
  cfg({ ROBOT_BACKOFF_BASE_MS: '0', ...over });

/** Deps that succeed with a full hand-off, unless a custom session result is given. */
function deps(sessionResult?: Partial<RobotSessionResult>): RobotDeps {
  return {
    ensureWorktree: async (_c, branch) => ({ dir: `/wt/${branch.replace('/', '-')}`, branch }),
    removeWorktree: async () => {},
    runSession: async () => ({ ok: true, sessionId: 'sess-1', verifyOk: true, prNumber: 314, ...sessionResult }),
    now: () => 1000,
  };
}

describe('processRobotQueue', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = boardDb();
  });

  it('branchFor uses the issue number, or t<id> when unlinked', () => {
    expect(branchFor({ id: 5, issueNumber: 220, repo: 'r', title: 't', body: null })).toBe('robot/220');
    expect(branchFor({ id: 5, issueNumber: null, repo: 'r', title: 't', body: null })).toBe('robot/t5');
  });

  it('does nothing when dispatch is disabled', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg({ ROBOT_DISPATCH_ENABLED: '0' }), deps());
    expect(n).toBe(0);
    expect(listRunsForTicket(db, 1)).toEqual([]);
  });

  it('fails closed when the DB-perms precondition is not met (uid configured, db absent)', async () => {
    addQueued(db, 1);
    // codingUid set forces the check; dbPathFor points at a nonexistent file ⇒ stat fails ⇒ not ok.
    const n = await processRobotQueue(db, cfg({ ROBOT_CODING_UID: '1500', DATA_DIR: '/nonexistent-xyz' }), deps());
    expect(n).toBe(0);
    expect(listRunsForTicket(db, 1)).toEqual([]);
    expect(agentState(db, 1)).toBeNull(); // never touched
  });

  it('happy path: worktree → session → verify-ok + PR → run handed-off + state in-review', async () => {
    addQueued(db, 1, 220);
    const n = await processRobotQueue(db, cfg(), deps({ turns: 7, tokens: 4200 }));
    expect(n).toBe(1);
    expect(agentState(db, 1)).toBe('in-review');
    const [run] = listRunsForTicket(db, 1);
    expect(run).toMatchObject({
      status: 'handed-off',
      branch: 'robot/220',
      sessionId: 'sess-1',
      prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314',
      turns: 7,
      tokens: 4200,
    });
    // C3: emits dispatched + handoff milestones onto the shared events timeline.
    expect(eventTypes(db, 1)).toEqual(['robot_dispatched', 'robot_handoff']);
  });

  it('no verify-ok ⇒ run no-verify (transient) + re-queued for retry (D-046 gate, no red PR)', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg(), deps({ ok: true, verifyOk: false, prNumber: undefined }));
    expect(n).toBe(0);
    expect(agentState(db, 1)).toBe('queued');
    const [run] = listRunsForTicket(db, 1);
    expect(run.status).toBe('no-verify');
    expect(run.faultTier).toBe('transient');
  });

  it('session error (unrecognised) ⇒ run error (transient) + re-queued', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg(), deps({ ok: false, verifyOk: false, error: 'max turns' }));
    expect(n).toBe(0);
    expect(agentState(db, 1)).toBe('queued');
    const [run] = listRunsForTicket(db, 1);
    expect(run.status).toBe('error');
    expect(run.error).toBe('max turns');
    expect(run.faultTier).toBe('transient');
  });

  // ---- C2 fault-tier guardrail (PD-343) ----

  it('a deterministic fault parks immediately (0 retries)', async () => {
    addQueued(db, 1);
    let calls = 0;
    const d = deps();
    d.runSession = async () => {
      calls++;
      return { ok: false, verifyOk: false, error: 'refused to edit protected path auth/session.ts' };
    };
    await processRobotQueue(db, cfg(), d);
    expect(agentState(db, 1)).toBe('stuck');
    expect(calls).toBe(1);
    expect(listRunsForTicket(db, 1)[0].faultTier).toBe('deterministic');
  });

  it('a transient fault retries up to the cap, then parks (distinct signatures)', async () => {
    addQueued(db, 1);
    const errors = ['flake-a', 'flake-b', 'flake-c'];
    let calls = 0;
    const d = deps();
    d.runSession = async () => ({ ok: false, verifyOk: false, error: errors[calls++] });
    const c = cfgNoBackoff();

    await processRobotQueue(db, c, d);
    expect(agentState(db, 1)).toBe('queued'); // retry 1
    await processRobotQueue(db, c, d);
    expect(agentState(db, 1)).toBe('queued'); // retry 2
    await processRobotQueue(db, c, d);
    expect(agentState(db, 1)).toBe('stuck'); // cap → park on the 3rd
    expect(calls).toBe(3);

    await processRobotQueue(db, c, d); // parked ⇒ no longer a candidate
    expect(calls).toBe(3);
    expect(listRunsForTicket(db, 1).length).toBe(3);
  });

  it('two identical failures stop at the second (transient→deterministic promotion)', async () => {
    addQueued(db, 1);
    let calls = 0;
    const d = deps();
    d.runSession = async () => {
      calls++;
      return { ok: true, verifyOk: false, prNumber: undefined }; // identical no-verify each time
    };
    const c = cfgNoBackoff();

    await processRobotQueue(db, c, d);
    expect(agentState(db, 1)).toBe('queued'); // first no-verify → retry
    await processRobotQueue(db, c, d);
    expect(agentState(db, 1)).toBe('stuck'); // same signature again → promoted → park
    expect(calls).toBe(2);

    await processRobotQueue(db, c, d);
    expect(calls).toBe(2);
    const runs = listRunsForTicket(db, 1);
    expect(runs.length).toBe(2);
    expect(runs[0].status).toBe('no-verify');
    expect(runs[0].faultTier).toBe('deterministic'); // the promoted run
  });

  it('a system-wide auth fault pauses the whole loop without burning any ticket', async () => {
    addQueued(db, 1);
    addQueued(db, 2);
    const d = deps();
    d.runSession = async (_c, cand) =>
      cand.id === 1
        ? { ok: false, verifyOk: false, error: 'GitHub API: HTTP 403 Forbidden' }
        : { ok: true, verifyOk: true, prNumber: 999 };

    const n = await processRobotQueue(db, cfg({ ROBOT_ALLOWLIST: '1,2', ROBOT_CONCURRENCY: '2' }), d);
    expect(n).toBe(0);
    expect(isDispatchPaused(db)).toBe(true);

    // ticket 1: recorded system-wide (excluded from the cap = no burn), returned to queued
    expect(agentState(db, 1)).toBe('queued');
    expect(listRunsForTicket(db, 1)[0].faultTier).toBe('system-wide');
    expect(failedRunsForTicket(db, 1).every((f) => f.tier === 'system-wide')).toBe(true);

    // ticket 2: never ran — the loop broke on the pause before reaching it
    expect(listRunsForTicket(db, 2)).toEqual([]);
    expect(agentState(db, 2)).toBeNull();

    // and the loop stays inert on the next cycle until a human resumes
    const n2 = await processRobotQueue(db, cfg({ ROBOT_ALLOWLIST: '1,2', ROBOT_CONCURRENCY: '2' }), d);
    expect(n2).toBe(0);
    expect(listRunsForTicket(db, 2)).toEqual([]);
  });

  it('ask_human parks awaiting-human and is not counted as a failure', async () => {
    addQueued(db, 1);
    const n = await processRobotQueue(db, cfg(), deps({ ok: true, verifyOk: false, prNumber: undefined, askHuman: 'Design A or B?' }));
    expect(n).toBe(0);
    expect(agentState(db, 1)).toBe('awaiting-human');
    const [run] = listRunsForTicket(db, 1);
    expect(run.status).toBe('ask-human');
    expect(run.faultReason).toContain('Design A or B');
    expect(failedRunsForTicket(db, 1)).toEqual([]); // not a failure ⇒ no budget burned
  });

  // ---- C3 observability milestones (PD-344) ----

  it('emits a robot_fault milestone on a transient retry and robot_parked on a deterministic park', async () => {
    addQueued(db, 1);
    const d = deps();
    d.runSession = async () => ({ ok: true, verifyOk: false, prNumber: undefined }); // transient no-verify
    await processRobotQueue(db, cfgNoBackoff(), d);
    expect(eventTypes(db, 1)).toEqual(['robot_dispatched', 'robot_fault']);

    addQueued(db, 2);
    const d2 = deps();
    d2.runSession = async () => ({ ok: false, verifyOk: false, error: 'permission denied' });
    await processRobotQueue(db, cfg({ ROBOT_ALLOWLIST: '2' }), d2);
    expect(eventTypes(db, 2)).toEqual(['robot_dispatched', 'robot_parked']);
  });

  it('emits robot_ask_human with the question in the detail', async () => {
    addQueued(db, 1);
    await processRobotQueue(db, cfg(), deps({ ok: true, verifyOk: false, prNumber: undefined, askHuman: 'A or B?' }));
    expect(eventTypes(db, 1)).toEqual(['robot_dispatched', 'robot_ask_human']);
    const ev = db.prepare("SELECT detail FROM agent_ticket_events WHERE ticket_id = 1 AND type = 'robot_ask_human'").get() as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ question: 'A or B?' });
  });

  it('emits robot_paused on the triggering ticket for a system-wide fault', async () => {
    addQueued(db, 1);
    await processRobotQueue(db, cfg(), deps({ ok: false, verifyOk: false, error: 'HTTP 401 Unauthorized' }));
    expect(eventTypes(db, 1)).toEqual(['robot_dispatched', 'robot_paused']);
  });

  it('parks a budget-exhausted ticket pre-dispatch without running it again', async () => {
    addQueued(db, 1);
    // Pre-load the cap with distinct transient signatures (as C2 finishRun records them).
    for (const sig of ['s1', 's2', 's3']) {
      finishRun(db, startRun(db, { ticketId: 1, issueNumber: 1, branch: 'robot/1' }), {
        status: 'error',
        faultTier: 'transient',
        faultSignature: sig,
      });
    }
    let sessionRan = false;
    const d = deps();
    d.runSession = async () => {
      sessionRan = true;
      return { ok: true, verifyOk: true, prNumber: 1 };
    };
    const n = await processRobotQueue(db, cfgNoBackoff(), d);
    expect(n).toBe(0);
    expect(sessionRan).toBe(false);
    expect(agentState(db, 1)).toBe('stuck');
  });

  it('respects the allowlist — an un-allowlisted queued ticket is left alone', async () => {
    addQueued(db, 1);
    addQueued(db, 2);
    const n = await processRobotQueue(db, cfg({ ROBOT_ALLOWLIST: '1' }), deps());
    expect(n).toBe(1);
    expect(agentState(db, 1)).toBe('in-review');
    expect(agentState(db, 2)).toBeNull(); // untouched
    expect(listRunsForTicket(db, 2)).toEqual([]);
  });
});
