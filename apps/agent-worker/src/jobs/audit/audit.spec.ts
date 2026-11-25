import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import {
  auditableProjects,
  claimNextRun,
  firstProjectWithActiveTickets,
  getAuditableTickets,
  projectByKey,
} from './audit-db';
import { parseAuditFindings, runAuditPass, singleScopeKey } from './audit';

// Minimal slice of the shared dashboard schema the audit job touches.
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_projects (
      id INTEGER PRIMARY KEY, slug TEXT, name TEXT NOT NULL, key TEXT,
      audit_enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT,
      status TEXT NOT NULL DEFAULT 'backlog', priority TEXT NOT NULL DEFAULT 'none',
      project_id INTEGER, archived_at INTEGER
    );
    CREATE TABLE audit_run (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'requested', scope TEXT,
      model TEXT, counts TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE audit_finding (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, project_id INTEGER, ticket_id INTEGER,
      type TEXT NOT NULL, recommendation TEXT, reason TEXT, evidence TEXT, proposed_change TEXT,
      confidence TEXT, decision TEXT NOT NULL DEFAULT 'undecided',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function requestRun(db: Database.Database): number {
  const r = db
    .prepare("INSERT INTO audit_run (status, created_at) VALUES ('requested', ?)")
    .run(Date.now());
  return Number(r.lastInsertRowid);
}

const config = { model: 'claude-opus-4-8', checkoutDir: '/nonexistent' } as AgentWorkerConfig;
const noContext = () => '';

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
});

describe('claimNextRun', () => {
  it('claims the oldest requested run and flips it to running', () => {
    const id = requestRun(db);
    const claimed = claimNextRun(db);
    expect(claimed).toEqual({ id, scope: null });
    expect(db.prepare('SELECT status FROM audit_run WHERE id = ?').get(id)).toEqual({ status: 'running' });
  });

  it('returns null on a second claim once the only run is running (Done-When #1)', () => {
    requestRun(db);
    expect(claimNextRun(db)).not.toBeNull();
    expect(claimNextRun(db)).toBeNull();
  });

  it('a direct claim UPDATE on an already-running row changes 0 rows (atomic)', () => {
    const id = requestRun(db);
    claimNextRun(db); // → running
    const res = db
      .prepare("UPDATE audit_run SET status='running' WHERE id=? AND status='requested'")
      .run(id);
    expect(res.changes).toBe(0);
  });

  it('claims runs in id order across successive calls', () => {
    const a = requestRun(db);
    const b = requestRun(db);
    expect(claimNextRun(db)?.id).toBe(a);
    expect(claimNextRun(db)?.id).toBe(b);
    expect(claimNextRun(db)).toBeNull();
  });
});

describe('firstProjectWithActiveTickets', () => {
  it('picks the lowest-id project that has active tickets', () => {
    db.prepare("INSERT INTO agent_projects (id, name) VALUES (1, 'Alpha')").run();
    db.prepare("INSERT INTO agent_projects (id, name) VALUES (2, 'Beta')").run();
    // Alpha has only a completed ticket; Beta has an active one.
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('x', 'completed', 1)").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('y', 'backlog', 2)").run();
    expect(firstProjectWithActiveTickets(db)?.id).toBe(2);
  });

  it('returns null when no project has active tickets', () => {
    db.prepare("INSERT INTO agent_projects (id, name) VALUES (1, 'Alpha')").run();
    expect(firstProjectWithActiveTickets(db)).toBeNull();
  });
});

describe('parseAuditFindings', () => {
  it('parses a bare JSON array', () => {
    expect(parseAuditFindings('[{"displayId":"PD-1","type":"archive"}]')).toHaveLength(1);
  });
  it('parses a fenced ```json block amid prose', () => {
    const text = 'Here you go:\n```json\n[{"displayId":"PD-2","type":"keep"}]\n```\nDone.';
    expect(parseAuditFindings(text)[0]).toMatchObject({ displayId: 'PD-2', type: 'keep' });
  });
  it('returns [] on unparseable text', () => {
    expect(parseAuditFindings('no json here')).toEqual([]);
  });
});

describe('runAuditPass', () => {
  function seedProjectWithTickets(): void {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'Personal Dashboard', 'PD')").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (10, 'PD-10', 'Stale thing', 'backlog', 1)").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (11, 'PD-11', 'Good thing', 'prioritized', 1)").run();
  }

  it('persists findings for one project and finishes the run with counts (Done-When #2)', async () => {
    seedProjectWithTickets();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({
      ok: true,
      text: '[{"displayId":"PD-10","type":"archive","recommendation":"archive it","reason":"superseded","evidence":"MEMORY 2026-07-06"}]',
    });

    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(counts).toMatchObject({ projects: 1, tickets: 2, findings: 1, archive: 1 });
    const findings = db.prepare('SELECT * FROM audit_finding WHERE run_id = ?').all(id) as {
      ticket_id: number;
      type: string;
      decision: string;
    }[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ticket_id: 10, type: 'archive', decision: 'undecided' });
    expect(db.prepare('SELECT status FROM audit_run WHERE id = ?').get(id)).toEqual({ status: 'done' });
  });

  it('drops findings that reference a ticket outside the audited set', async () => {
    seedProjectWithTickets();
    const run = claimNextRun(db) ?? { id: requestRun(db), scope: null };
    const runAgent = async () => ({ ok: true, text: '[{"displayId":"PD-999","type":"archive"}]' });
    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(counts.findings).toBe(0);
  });

  it('finishes done with zero counts when no project has active tickets', async () => {
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({ ok: true, text: '[]' });
    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(counts).toEqual({ projects: 0, tickets: 0, findings: 0 });
    expect(db.prepare('SELECT status FROM audit_run WHERE id = ?').get(id)).toEqual({ status: 'done' });
  });

  it('a single failing project is logged and skipped — the run still finishes done (PD-284)', async () => {
    // Under fan-out a project erroring no longer aborts the run (Done-When #3); it's skipped and
    // the run closes done with no findings for it, rather than throwing to force a retry.
    seedProjectWithTickets();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({ ok: false, text: 'Credit balance is too low' });
    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(counts).toMatchObject({ projects: 0, findings: 0 });
    expect(db.prepare('SELECT * FROM audit_finding WHERE run_id = ?').all(id)).toHaveLength(0);
    expect(db.prepare('SELECT status FROM audit_run WHERE id = ?').get(id)).toEqual({ status: 'done' });
  });
});

describe('getAuditableTickets', () => {
  it('returns only active, un-archived tickets for the project', () => {
    db.prepare("INSERT INTO agent_projects (id, name) VALUES (1, 'P')").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('a', 'backlog', 1)").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('b', 'completed', 1)").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id, archived_at) VALUES ('c', 'backlog', 1, 123)").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('d', 'queue', 1)").run();
    const rows = getAuditableTickets(db, 1);
    expect(rows.map((r) => r.title).sort()).toEqual(['a', 'd']);
  });
});

// ── PD-284: per-project fan-out + per-project pause + confidence ──────────────

describe('singleScopeKey', () => {
  it('extracts the KEY from a single:<KEY> scope', () => {
    expect(singleScopeKey('single:PD')).toBe('PD');
    expect(singleScopeKey('single:CORE')).toBe('CORE');
  });
  it('returns null for a full-sweep (null or non-single) scope', () => {
    expect(singleScopeKey(null)).toBeNull();
    expect(singleScopeKey('all')).toBeNull();
  });
});

describe('auditableProjects / projectByKey (PD-284)', () => {
  function seedTwoEnabledProjects(): void {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'Personal Dashboard', 'PD')").run();
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (2, 'Core', 'CORE')").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('a', 'backlog', 1)").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('b', 'queue', 2)").run();
  }

  it('returns every enabled project that has active tickets, in id order', () => {
    seedTwoEnabledProjects();
    expect(auditableProjects(db).map((p) => p.key)).toEqual(['PD', 'CORE']);
  });

  it('excludes a project with audit_enabled = 0', () => {
    seedTwoEnabledProjects();
    db.prepare('UPDATE agent_projects SET audit_enabled = 0 WHERE id = 2').run();
    expect(auditableProjects(db).map((p) => p.key)).toEqual(['PD']);
  });

  it('excludes a project with no active tickets', () => {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'Empty', 'E')").run();
    db.prepare("INSERT INTO agent_tickets (title, status, project_id) VALUES ('done', 'completed', 1)").run();
    expect(auditableProjects(db)).toHaveLength(0);
  });

  it('projectByKey finds a project regardless of its audit_enabled flag', () => {
    seedTwoEnabledProjects();
    db.prepare('UPDATE agent_projects SET audit_enabled = 0 WHERE id = 2').run();
    expect(projectByKey(db, 'CORE')?.id).toBe(2);
    expect(projectByKey(db, 'NOPE')).toBeNull();
  });
});

describe('runAuditPass — fan-out (PD-284)', () => {
  function seedTwoProjects(): void {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'Personal Dashboard', 'PD')").run();
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (2, 'Core', 'CORE')").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (10, 'PD-10', 'A', 'backlog', 1)").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (20, 'CORE-20', 'B', 'backlog', 2)").run();
  }

  const findingsFor = (runId: number) =>
    db.prepare('SELECT project_id, ticket_id, type, confidence FROM audit_finding WHERE run_id = ? ORDER BY ticket_id').all(runId) as {
      project_id: number;
      ticket_id: number;
      type: string;
      confidence: string | null;
    }[];

  it('audits ≥2 projects, tags findings by project with confidence, and counts the real number (Done-When #2)', async () => {
    seedTwoProjects();
    const id = requestRun(db); // scope null → full sweep
    const run = claimNextRun(db)!;
    const runAgent = async (_c: unknown, _s: string, prompt: string) => {
      if (prompt.includes('Personal Dashboard'))
        return { ok: true, text: '[{"displayId":"PD-10","type":"archive","confidence":"high"}]' };
      if (prompt.includes('Core'))
        return { ok: true, text: '[{"displayId":"CORE-20","type":"update","confidence":"low"}]' };
      return { ok: true, text: '[]' };
    };

    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(counts).toMatchObject({ projects: 2, tickets: 2, findings: 2 });
    expect(findingsFor(id)).toEqual([
      { project_id: 1, ticket_id: 10, type: 'archive', confidence: 'high' },
      { project_id: 2, ticket_id: 20, type: 'update', confidence: 'low' },
    ]);
    // A full sweep records scope = 'all'.
    expect(db.prepare('SELECT scope, status FROM audit_run WHERE id = ?').get(id)).toEqual({ scope: 'all', status: 'done' });
  });

  it('one project erroring/timing out does not abort the run — the others still persist (Done-When #3)', async () => {
    seedTwoProjects();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async (_c: unknown, _s: string, prompt: string) => {
      if (prompt.includes('Core')) throw new Error('simulated timeout');
      return { ok: true, text: '[{"displayId":"PD-10","type":"archive","confidence":"medium"}]' };
    };

    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(counts).toMatchObject({ projects: 1, findings: 1 });
    expect(findingsFor(id)).toEqual([{ project_id: 1, ticket_id: 10, type: 'archive', confidence: 'medium' }]);
    expect(db.prepare('SELECT status FROM audit_run WHERE id = ?').get(id)).toEqual({ status: 'done' });
  });

  it('a project with audit_enabled = 0 is skipped — no agent turn, no tokens (Done-When #4)', async () => {
    seedTwoProjects();
    db.prepare('UPDATE agent_projects SET audit_enabled = 0 WHERE id = 2').run();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const prompts: string[] = [];
    const runAgent = async (_c: unknown, _s: string, prompt: string) => {
      prompts.push(prompt);
      return { ok: true, text: '[{"displayId":"PD-10","type":"keep","confidence":"high"}]' };
    };

    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(counts.projects).toBe(1);
    expect(prompts).toHaveLength(1); // only the enabled project got a turn
    expect(prompts[0]).toContain('Personal Dashboard');
    expect(prompts.some((p) => p.includes('"Core"') || p.includes('project "Core"'))).toBe(false);
    expect(findingsFor(id).map((f) => f.project_id)).toEqual([1]);
  });

  it('a single:<KEY> scope audits just that project, overriding its pause', async () => {
    seedTwoProjects();
    db.prepare('UPDATE agent_projects SET audit_enabled = 0 WHERE id = 2').run(); // Core is paused…
    const id = requestRun(db);
    const run = { id, scope: 'single:CORE' }; // …but an explicit single run targets it anyway
    const prompts: string[] = [];
    const runAgent = async (_c: unknown, _s: string, prompt: string) => {
      prompts.push(prompt);
      return { ok: true, text: '[{"displayId":"CORE-20","type":"update","confidence":"low"}]' };
    };

    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(counts).toMatchObject({ projects: 1, findings: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Core');
    expect(findingsFor(id)).toEqual([{ project_id: 2, ticket_id: 20, type: 'update', confidence: 'low' }]);
    expect(db.prepare('SELECT scope FROM audit_run WHERE id = ?').get(id)).toEqual({ scope: 'single:CORE' });
  });

  it('coerces an invalid confidence to null (PD-284)', async () => {
    seedTwoProjects();
    db.prepare('UPDATE agent_projects SET audit_enabled = 0 WHERE id = 2').run();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({ ok: true, text: '[{"displayId":"PD-10","type":"archive","confidence":"very-sure"}]' });
    await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(findingsFor(id)[0].confidence).toBeNull();
  });
});

// ── PD-910: live turns / tokens on audit_run ──────────────────────────────────

describe('runAuditPass — live turns and tokens (PD-910)', () => {
  function seed(): void {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'Personal Dashboard', 'PD')").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (10, 'PD-10', 'A', 'backlog', 1)").run();
  }
  const usageOf = (id: number) =>
    db.prepare('SELECT turns, tokens, status FROM audit_run WHERE id = ?').get(id) as {
      turns: number | null;
      tokens: number | null;
      status: string;
    };

  it('writes progress live while the agent runs, then the authoritative totals', async () => {
    db.exec('ALTER TABLE audit_run ADD COLUMN turns INTEGER; ALTER TABLE audit_run ADD COLUMN tokens INTEGER;');
    seed();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    let midRun: ReturnType<typeof usageOf> | undefined;
    const runAgent = async (_c: unknown, _s: string, _p: string, onProgress?: (t: number, k?: number) => void) => {
      onProgress?.(1, 1200);
      onProgress?.(2); // unknown this turn — keeps the known total
      midRun = usageOf(id);
      return { ok: true, text: '[]', turns: 3, tokens: 4000 };
    };

    await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(midRun).toMatchObject({ turns: 2, tokens: 1200, status: 'running' });
    expect(usageOf(id)).toMatchObject({ turns: 3, tokens: 4000, status: 'done' });
  });

  it('still finishes the audit when audit_run has not been migrated yet (worker deployed first)', async () => {
    // freshDb's audit_run has no turns/tokens columns — the pre-migration shape.
    seed();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async (_c: unknown, _s: string, _p: string, onProgress?: (t: number, k?: number) => void) => {
      expect(() => onProgress?.(1, 10)).toThrow(); // the raw write fails; the real agent wraps it in safeProgress
      return { ok: true, text: '[]', turns: 1, tokens: 10 };
    };

    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });

    expect(counts).toMatchObject({ projects: 1, findings: 0 });
    expect((db.prepare('SELECT status FROM audit_run WHERE id = ?').get(id) as { status: string }).status).toBe('done');
  });
});
