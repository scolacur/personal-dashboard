import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { claimNextRun, firstProjectWithActiveTickets, getAuditableTickets, getRelationsForTickets } from './audit-db';
import { parseAuditFindings, runAuditPass } from './audit';

// Minimal slice of the shared dashboard schema the audit job touches.
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_projects (
      id INTEGER PRIMARY KEY, slug TEXT, name TEXT NOT NULL, key TEXT
    );
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT,
      status TEXT NOT NULL DEFAULT 'backlog', priority TEXT NOT NULL DEFAULT 'none',
      project_id INTEGER, archived_at INTEGER
    );
    CREATE TABLE agent_ticket_relations (
      id INTEGER PRIMARY KEY,
      from_ticket_id INTEGER NOT NULL, to_ticket_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'blocks', origin TEXT NOT NULL DEFAULT 'agent',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE audit_run (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'requested', scope TEXT,
      model TEXT, counts TEXT, started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE audit_finding (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, project_id INTEGER, ticket_id INTEGER,
      target_ticket_id INTEGER, relation_type TEXT,
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

  it('throws on an agent error so the run is retried (not persisted as empty)', async () => {
    seedProjectWithTickets();
    const run = claimNextRun(db) ?? { id: requestRun(db), scope: null };
    const runAgent = async () => ({ ok: false, text: 'Credit balance is too low' });
    await expect(runAuditPass(db, config, run, { runAgent, buildContext: noContext })).rejects.toThrow(/audit agent turn failed/);
  });
});

// ── PD-828: relations as truth + relation findings ───────────────────────────

describe('getRelationsForTickets', () => {
  function seedTickets(): void {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'P', 'PD')").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (10, 'PD-10', 'A', 'backlog', 1)").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (11, 'PD-11', 'B', 'backlog', 1)").run();
  }
  function rel(from: number, to: number, type: string): void {
    db.prepare(
      "INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (?, ?, ?, ?)",
    ).run(from, to, type, Date.now());
  }

  it('resolves both the from and to ends relative to each audited subject', () => {
    seedTickets();
    rel(10, 11, 'blocks');
    const rels = getRelationsForTickets(db, [10, 11]);
    expect(rels).toContainEqual(
      expect.objectContaining({ subjectId: 10, otherId: 11, type: 'blocks', direction: 'from' }),
    );
    expect(rels).toContainEqual(
      expect.objectContaining({ subjectId: 11, otherId: 10, type: 'blocks', direction: 'to' }),
    );
  });

  it('returns [] for no ticket ids', () => {
    expect(getRelationsForTickets(db, [])).toEqual([]);
  });
});

describe('runAuditPass — relation findings (PD-828)', () => {
  function seed(): void {
    db.prepare("INSERT INTO agent_projects (id, name, key) VALUES (1, 'Personal Dashboard', 'PD')").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (10, 'PD-10', 'Dup', 'backlog', 1)").run();
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id) VALUES (11, 'PD-11', 'Canon', 'backlog', 1)").run();
  }
  const findingsOf = (runId: number) =>
    db
      .prepare('SELECT ticket_id, target_ticket_id, relation_type, type FROM audit_finding WHERE run_id = ?')
      .all(runId) as { ticket_id: number; target_ticket_id: number | null; relation_type: string | null; type: string }[];

  it('persists a duplicate finding with its target + relation type resolved (Done-When #3)', async () => {
    seed();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({
      ok: true,
      text: '[{"displayId":"PD-10","type":"duplicate","target":"PD-11","reason":"same ask"}]',
    });
    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(counts).toMatchObject({ findings: 1, duplicate: 1 });
    expect(findingsOf(id)).toEqual([
      { ticket_id: 10, target_ticket_id: 11, relation_type: 'duplicates', type: 'duplicate' },
    ]);
  });

  it('persists a link finding with the proposed relates/blocks type', async () => {
    seed();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({
      ok: true,
      text: '[{"displayId":"PD-10","type":"link","target":"PD-11","relationType":"blocks"}]',
    });
    await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(findingsOf(id)).toEqual([
      { ticket_id: 10, target_ticket_id: 11, relation_type: 'blocks', type: 'link' },
    ]);
  });

  it('drops a relation finding whose target cannot be resolved (Done-When #3)', async () => {
    seed();
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({
      ok: true,
      text: '[{"displayId":"PD-10","type":"link","target":"PD-999","relationType":"relates"}]',
    });
    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(counts.findings).toBe(0);
    expect(findingsOf(id)).toEqual([]);
  });

  it('does not re-emit a link that already exists (Done-When #2)', async () => {
    seed();
    db.prepare(
      "INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (10, 11, 'relates', ?)",
    ).run(Date.now());
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    // Agent re-proposes the existing relates link in the reverse direction — still de-duped.
    const runAgent = async () => ({
      ok: true,
      text: '[{"displayId":"PD-11","type":"link","target":"PD-10","relationType":"relates"}]',
    });
    const counts = await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(counts.findings).toBe(0);
    expect(findingsOf(id)).toEqual([]);
  });

  it('injects existing relations into the agent prompt (Done-When #2)', async () => {
    seed();
    db.prepare(
      "INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (10, 11, 'blocks', ?)",
    ).run(Date.now());
    requestRun(db);
    const run = claimNextRun(db)!;
    let seenPrompt = '';
    const runAgent = async (_c: unknown, _s: string, prompt: string) => {
      seenPrompt = prompt;
      return { ok: true, text: '[]' };
    };
    await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(seenPrompt).toContain('relation: PD-10 blocks PD-11');
  });

  it('resolves an unlink target that is an archived ticket outside the audit surface', async () => {
    seed();
    // PD-12 is archived → not in the audit surface, but it is the far end of an existing relation.
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, project_id, archived_at) VALUES (12, 'PD-12', 'Gone', 'closed', 1, 123)").run();
    db.prepare(
      "INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (10, 12, 'relates', ?)",
    ).run(Date.now());
    const id = requestRun(db);
    const run = claimNextRun(db)!;
    const runAgent = async () => ({
      ok: true,
      text: '[{"displayId":"PD-10","type":"unlink","target":"PD-12","relationType":"relates","reason":"stale"}]',
    });
    await runAuditPass(db, config, run, { runAgent, buildContext: noContext });
    expect(findingsOf(id)).toEqual([
      { ticket_id: 10, target_ticket_id: 12, relation_type: 'relates', type: 'unlink' },
    ]);
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
