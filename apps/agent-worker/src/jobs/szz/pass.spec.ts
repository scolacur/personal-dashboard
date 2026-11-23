import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runSzzPass } from './pass';
import type { AgentWorkerConfig } from '../../shared/config';

/**
 * PD-916 — the pass over a fake history shaped like the 2026-11-22 probe: PD-784's fix (#461)
 * blames mostly to PD-346's PR (#251), a little to PD-342's (#230).
 */

const S = (c: string) => c.repeat(40);
const FIX = S('f');
const PD346 = S('a');
const PD342 = S('b');
const ROBOTPR = S('c');
const ADDONLY = S('d');
const MEMO = S('e');

const LOG = [
  `${MEMO}\x1f1800000000\x1fchore(memory): notes on PD-901 (#470)`,
  `${ADDONLY}\x1f1790000000\x1ffix: add the missing guard (PD-900) (#465)`,
  `${FIX}\x1f1785000000\x1ffix(robot): reclaim orphans by ownership (PD-784, D-104) (#461)`,
  `${ROBOTPR}\x1f1784000000\x1f[Robot] something (#300)`,
  `${PD346}\x1f1752700000\x1ffeat(agent-worker): fold the sortie bridges (PD-346, C5) (#251)`,
  `${PD342}\x1f1752000000\x1ffeat(agent-worker): Robot loop skeleton (PD-342, C1) (#230)`,
].join('\n');

function blame(lines: [string, string][]): string {
  return lines
    .map(([sha, content], i) => `${sha} ${i + 1} ${i + 1} 1\nauthor x\n\t${content}`)
    .join('\n');
}

function fakeGit(calls: string[][] = []) {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    const a = args.join(' ');
    if (a === 'rev-parse origin/main') return 'HEAD1\n';
    if (a.startsWith('log --first-parent')) return LOG;
    if (a === `diff --no-renames --name-only ${FIX}^ ${FIX}`)
      return 'apps/w/stall.ts\napps/w/stall.spec.ts\nMEMORY/x.md\n';
    if (a === `diff --no-renames -U0 ${FIX}^ ${FIX} -- apps/w/stall.ts`)
      return '@@ -10,4 +10,2 @@\n@@ -40,0 +38,9 @@\n';
    if (a === `blame -w --line-porcelain -L 10,+4 ${FIX}^ -- apps/w/stall.ts`) {
      return blame([
        [PD346, 'if (age > TWO_HOURS) reclaim(run);'],
        [PD346, 'const age = now - run.startedAt;'],
        [PD342, 'reclaim(run);'],
        [PD346, '}'],
      ]);
    }
    if (a === `diff --no-renames --name-only ${ADDONLY}^ ${ADDONLY}`) return 'apps/w/guard.ts\n';
    if (a === `diff --no-renames -U0 ${ADDONLY}^ ${ADDONLY} -- apps/w/guard.ts`)
      return '@@ -5,0 +6,3 @@\n';
    if (a === `diff --no-renames --name-only ${MEMO}^ ${MEMO}`) return 'MEMORY/runs/x.md\n';
    throw new Error(`unexpected git ${a}`);
  };
}

const CONFIG = { githubRepo: 'scolacur/personal-dashboard' } as AgentWorkerConfig;

function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_projects (id INTEGER PRIMARY KEY, github_repo TEXT);
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, kind TEXT, is_epic INTEGER,
      archived_at INTEGER, status TEXT, project_id INTEGER);
    CREATE TABLE agent_runs (ticket_id INTEGER, pr_url TEXT);
    INSERT INTO agent_projects VALUES (1, 'scolacur/personal-dashboard'), (2, 'scolacur/core');
    INSERT INTO agent_tickets VALUES
      (784, 'PD-784', 'bug', 0, NULL, 'completed', 1),
      (900, 'PD-900', 'bug', 0, NULL, 'completed', 1),
      (901, 'PD-901', 'bug', 0, NULL, 'completed', 1),
      (902, 'PD-902', 'bug', 0, NULL, 'queue', 1),
      (903, 'C-3', 'bug', 0, NULL, 'completed', 2),
      (904, 'PD-904', 'feature', 0, NULL, 'completed', 1);
    INSERT INTO agent_runs VALUES (55, 'https://github.com/o/r/pull/300');
  `);
  return db;
}

describe('runSzzPass', () => {
  it('traces PD-784 to PD-346 (#251) as top suspect, keeping PD-342 as a candidate', async () => {
    const db = seed();
    expect(await runSzzPass(db, CONFIG, { git: fakeGit(), refresh: async () => {}, now: 1 })).toBe(
      3,
    );
    const cands = db
      .prepare(
        'SELECT pr_number, ticket_ids, lines, is_top, robot FROM szz_candidate WHERE ticket_id = 784 ORDER BY lines DESC',
      )
      .all();
    expect(cands).toEqual([
      { pr_number: 251, ticket_ids: '["PD-346"]', lines: 2, is_top: 1, robot: 0 }, // the "}" line is noise
      { pr_number: 230, ticket_ids: '["PD-342"]', lines: 1, is_top: 0, robot: 0 },
    ]);
  });

  it('records add-only fixes as untraceable and memory-only mentions as unlinked; skips open, other-repo and non-bug tickets', async () => {
    const db = seed();
    await runSzzPass(db, CONFIG, { git: fakeGit(), refresh: async () => {}, now: 1 });
    const status = Object.fromEntries(
      (
        db.prepare('SELECT ticket_id, status FROM szz_bug').all() as {
          ticket_id: number;
          status: string;
        }[]
      ).map((r) => [r.ticket_id, r.status]),
    );
    expect(status).toEqual({ 784: 'traced', 900: 'untraceable', 901: 'unlinked' });
  });

  it('records every merged PR, flagging Robot ones from agent_runs', async () => {
    const db = seed();
    await runSzzPass(db, CONFIG, { git: fakeGit(), refresh: async () => {}, now: 1 });
    expect(db.prepare('SELECT count(*) n, sum(robot) r FROM szz_pr').get()).toEqual({ n: 6, r: 1 });
  });

  it('skips the pass when neither main nor the fixed-bug set moved', async () => {
    const db = seed();
    const deps = { git: fakeGit(), refresh: async () => {}, now: 1 };
    await runSzzPass(db, CONFIG, deps);
    const calls: string[][] = [];
    expect(await runSzzPass(db, CONFIG, { ...deps, git: fakeGit(calls) })).toBe('skipped');
    expect(calls.map((c) => c[0])).toEqual(['rev-parse']);
  });

  it('works when agent_runs does not exist yet', async () => {
    const db = seed();
    db.exec('DROP TABLE agent_runs');
    await runSzzPass(db, CONFIG, { git: fakeGit(), refresh: async () => {}, now: 1 });
    expect(db.prepare('SELECT count(*) n, sum(robot) r FROM szz_pr').get()).toEqual({ n: 6, r: 0 });
  });
});
