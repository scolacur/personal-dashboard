import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  createTicket,
  getDispatchPauseState,
  getProjectBySlug,
  getRobotBudget,
  getSessionLimitHold,
  getGithubRateLimit,
  getSortieFleet,
  listWorkerHeartbeats,
} from './store';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function pdId(db: Database.Database): number {
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no PD project');
  return p.id;
}

/**
 * Seed a ticket in a given Robot loop agent_state (the loop normally sets this).
 *
 * Seeds into the **Queue**, which is where a ticket carrying an agent state actually lives — the
 * loop only ever writes one to a ticket it has dispatched. These fixtures previously left the
 * status at its `backlog` default, which no real dispatched ticket ever has, and PD-606's scoping
 * made that divergence visible.
 */
function seedTicket(
  db: Database.Database,
  title: string,
  agentState: string | null,
  status: string = 'queue',
): number {
  const t = createTicket(db, { title, projectId: pdId(db) });
  db.prepare('UPDATE agent_tickets SET agent_state = ?, status = ? WHERE id = ?').run(agentState, status, t.id);
  return t.id;
}

describe('getSortieFleet', () => {
  it('counts active tickets by agent_state, omitting null/zero states', () => {
    const db = freshDb();
    seedTicket(db, 'a', 'working');
    seedTicket(db, 'b', 'working');
    seedTicket(db, 'c', 'stuck');
    seedTicket(db, 'd', null); // manual ticket — no agent state
    expect(getSortieFleet(db)).toEqual({ working: 2, stuck: 1 });
  });

  it('excludes archived tickets', () => {
    const db = freshDb();
    const id = seedTicket(db, 'a', 'working');
    seedTicket(db, 'b', 'working');
    db.prepare('UPDATE agent_tickets SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    expect(getSortieFleet(db)).toEqual({ working: 1 });
  });

  it('returns an empty map when nothing has an agent state', () => {
    const db = freshDb();
    seedTicket(db, 'a', null);
    expect(getSortieFleet(db)).toEqual({});
  });

  /**
   * PD-606. These counts describe the Robot's fleet, and nothing outside the Queue is in it.
   *
   * Counting every row meant a stale `agent_state` on a Backlog ticket read as live work: the nav
   * said "2 queued" while the Queue column was empty, and the two rows behind it (PD-377, PD-464)
   * had been sitting in Backlog for weeks. Scoping the query makes the count true regardless of how
   * a stale row got there — which the write-side fixes cannot promise on their own, because they
   * only ever apply going forward.
   */
  it('ignores a stale agent_state on a ticket that is not in the Queue', () => {
    const db = freshDb();
    seedTicket(db, 'genuinely queued', 'working');
    seedTicket(db, 'dragged back to backlog', 'queued', 'backlog');
    seedTicket(db, 'finished', 'done', 'completed');
    expect(getSortieFleet(db)).toEqual({ working: 1 });
  });
});

describe('listWorkerHeartbeats', () => {
  it('maps rows to camelCase, freshest first', () => {
    const db = freshDb();
    const ins = db.prepare(
      `INSERT INTO worker_heartbeat (worker, started_at, last_seen, pid, sha, build_sha, model)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run('agent-worker', 1000, 5000, 42, 'abc123', 'def456', 'claude-opus-4-8');
    ins.run('other-worker', 1000, 9000, 7, null, null, null);

    const hbs = listWorkerHeartbeats(db);
    expect(hbs.map((h) => h.worker)).toEqual(['other-worker', 'agent-worker']);
    expect(hbs[1]).toEqual({
      worker: 'agent-worker',
      startedAt: 1000,
      lastSeen: 5000,
      pid: 42,
      // PD-528: `sha` is the GROUNDING CHECKOUT's head; `build_sha` is the code actually running.
      // The names are distinct in the API because conflating them is what let a week-old container
      // advertise a fresh version.
      checkoutSha: 'abc123',
      buildSha: 'def456',
      model: 'claude-opus-4-8',
    });
  });

  it('reports a pre-PD-528 image as buildSha null rather than borrowing the checkout sha', () => {
    // An image built before the build-arg existed has no version to report. Falling back to the
    // checkout sha would recreate the exact bug: a number that looks like a version and is not.
    const db = freshDb();
    db.prepare(
      `INSERT INTO worker_heartbeat (worker, started_at, last_seen, pid, sha, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('agent-worker', 1000, 5000, 42, 'abc123', 'claude-opus-4-8');

    const hb = listWorkerHeartbeats(db)[0];
    expect(hb.checkoutSha).toBe('abc123');
    expect(hb.buildSha).toBeNull();
  });

  it('is empty before any worker has beaten', () => {
    expect(listWorkerHeartbeats(freshDb())).toEqual([]);
  });
});

describe('getDispatchPauseState', () => {
  // robot_state is worker-owned; mirror the worker's create so the server can read it.
  function withRobotState(db: Database.Database): void {
    db.exec('CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
  }

  it('reports running when the robot_state table does not exist yet', () => {
    expect(getDispatchPauseState(freshDb())).toEqual({ paused: false, reason: null, since: null });
  });

  it('reports running when the flag row is absent or cleared (null value)', () => {
    const db = freshDb();
    withRobotState(db);
    expect(getDispatchPauseState(db)).toEqual({ paused: false, reason: null, since: null });
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)').run('dispatch_paused', 5);
    expect(getDispatchPauseState(db)).toEqual({ paused: false, reason: null, since: null });
  });

  it('reports paused with reason + since when the flag is set', () => {
    const db = freshDb();
    withRobotState(db);
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'dispatch_paused',
      'auth/credit fault (loop-wide): HTTP 403',
      1700,
    );
    expect(getDispatchPauseState(db)).toEqual({
      paused: true,
      reason: 'auth/credit fault (loop-wide): HTTP 403',
      since: 1700,
    });
  });
});

describe('getSessionLimitHold (PD-470)', () => {
  function withHold(
    db: Database.Database,
    until: number,
    reason = 'provider session limit',
    kind?: 'session-limit' | 'github-rate-limit',
  ): void {
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'session_limit_until',
      // `kind` omitted reproduces a row written before PD-248 — the backward-compat case below.
      JSON.stringify(kind === undefined ? { until, reason } : { until, reason, kind }),
      1000,
    );
  }

  it('reads null when the worker has never booted (no robot_state table)', () => {
    expect(getSessionLimitHold(freshDb())).toBeNull();
  });

  // A row written before PD-248 carries no `kind`, and every one of them WAS a session limit —
  // so the default is not a guess, it is what those rows meant.
  it('reads a pre-PD-248 row with no kind as a session limit', () => {
    const db = freshDb();
    withHold(db, 9000);
    expect(getSessionLimitHold(db, 5000)).toEqual({
      kind: 'session-limit',
      until: 9000,
      reason: 'provider session limit',
      since: 1000,
    });
  });

  it('reports a GitHub rate-limit hold as its own kind, not as a session limit', () => {
    const db = freshDb();
    withHold(db, 9000, 'GitHub rate limit: HTTP 429', 'github-rate-limit');
    expect(getSessionLimitHold(db, 5000)).toMatchObject({ kind: 'github-rate-limit', until: 9000 });
  });

  it('falls back to session-limit for an unrecognised kind rather than passing it through', () => {
    const db = freshDb();
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'session_limit_until',
      JSON.stringify({ until: 9000, reason: 'x', kind: 'something-new' }),
      1000,
    );
    expect(getSessionLimitHold(db, 5000)?.kind).toBe('session-limit');
  });

  // The row survives until the worker's next cycle clears it, so the READ has to expire it too —
  // showing "waiting until 5:30" after 5:30 would be a lie the UI has no way to catch.
  it('reports an expired hold as no hold at all', () => {
    const db = freshDb();
    withHold(db, 9000);
    expect(getSessionLimitHold(db, 9000)).toBeNull();
    expect(getSessionLimitHold(db, 12_000)).toBeNull();
  });

  it('survives a corrupt row rather than breaking the status endpoint', () => {
    const db = freshDb();
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run('session_limit_until', '{oops', 1000);
    expect(getSessionLimitHold(db, 5000)).toBeNull();
  });
});

describe('getRobotBudget (PD-463)', () => {
  function withPolicy(db: Database.Database, policy: unknown): void {
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'budget_policy',
      JSON.stringify(policy),
      1000,
    );
  }

  function withRuns(db: Database.Database, rows: { turns: number; tokens: number; finishedAt: number }[]): void {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY, ticket_id INTEGER, turns INTEGER, tokens INTEGER,
      started_at INTEGER, finished_at INTEGER
    )`);
    for (const r of rows) {
      db.prepare('INSERT INTO agent_runs (ticket_id, turns, tokens, started_at, finished_at) VALUES (1, ?, ?, ?, ?)').run(
        r.turns,
        r.tokens,
        r.finishedAt,
        r.finishedAt,
      );
    }
  }

  // No published policy ⇒ nothing to show. Inventing a ceiling the loop is not enforcing would be
  // worse than an empty panel: the numbers would look authoritative and be fiction.
  it('is null until a worker publishes a policy', () => {
    expect(getRobotBudget(freshDb())).toBeNull();
    const db = freshDb();
    db.exec('CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    expect(getRobotBudget(db)).toBeNull();
  });

  it('reports spend in the window against the published ceiling', () => {
    const db = freshDb();
    withPolicy(db, { windowMs: 1000, turns: 500, tokens: 0 });
    withRuns(db, [
      { turns: 40, tokens: 900, finishedAt: 9500 },
      { turns: 12, tokens: 100, finishedAt: 9000 }, // exactly on the boundary
      { turns: 99, tokens: 999, finishedAt: 8999 }, // aged out
    ]);
    expect(getRobotBudget(db, 10_000)).toEqual({
      windowMs: 1000,
      turnsUsed: 52,
      turnsLimit: 500,
      tokensUsed: 1000,
      tokensLimit: null, // the token limb is off
    });
  });

  it('survives a corrupt policy row and an absent agent_runs table', () => {
    const db = freshDb();
    db.exec('CREATE TABLE robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run('budget_policy', '{oops', 1000);
    expect(getRobotBudget(db)).toBeNull();

    withPolicy(db, { windowMs: 1000, turns: 500, tokens: 0 }); // valid policy, no runs table yet
    expect(getRobotBudget(db, 10_000)).toMatchObject({ turnsUsed: 0, tokensUsed: 0 });
  });
});

describe('getGithubRateLimit (PD-248)', () => {
  function withProbe(db: Database.Database, value: string): void {
    db.exec('CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'github_rate_limit',
      value,
      1000,
    );
  }

  const reading = {
    core: { remaining: 4900, limit: 5000, resetAt: 9_000_000 },
    graphql: null,
    checkedAt: 1000,
  };

  it('reads null when the worker has never probed', () => {
    expect(getGithubRateLimit(freshDb())).toBeNull();
  });

  it('returns the stored reading', () => {
    const db = freshDb();
    withProbe(db, JSON.stringify(reading));
    expect(getGithubRateLimit(db)).toEqual(reading);
  });

  // Deliberately NOT expired here, unlike the hold above. Staleness is the reader's call
  // (`rateLimitHealth`) — dropping an old reading here would make a FAILING probe look identical
  // to one that has never run, and those want different responses.
  it('returns an old reading rather than hiding it, so staleness stays visible', () => {
    const db = freshDb();
    withProbe(db, JSON.stringify({ ...reading, checkedAt: 1 }));
    expect(getGithubRateLimit(db)?.checkedAt).toBe(1);
  });

  it.each([
    ['corrupt JSON', '{oops'],
    ['a payload with no core bucket', JSON.stringify({ checkedAt: 1000 })],
    ['a payload with no checkedAt', JSON.stringify({ core: { remaining: 1, limit: 2, resetAt: 3 } })],
  ])('survives %s rather than breaking the status endpoint', (_label, raw) => {
    const db = freshDb();
    withProbe(db, raw);
    expect(getGithubRateLimit(db)).toBeNull();
  });
});
