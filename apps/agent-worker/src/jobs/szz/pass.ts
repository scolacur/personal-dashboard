import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { ensureHistoryClone, gitOutput } from '../../shared/checkout';
import { logger } from '../../shared/logger';
import {
  findFixCommits,
  isCodePath,
  isNoiseLine,
  parseBlamePorcelain,
  parseLog,
  parseOldHunks,
  prNumberFromUrl,
  prNumberOf,
  ticketIdsIn,
  topSuspect,
  type Candidate,
  type MainCommit,
  type SzzStatus,
} from './analyze';

/**
 * SZZ pass (PD-916): for every completed `kind = 'bug'` ticket of the worker's repo, find its fix
 * commits on main, blame the lines they changed, and record who wrote them. The worker owns these
 * tables (like `agent_runs`); the server only reads them, treating a missing table as empty.
 * Recomputed wholesale each time it runs — a few dozen bugs — so there is no incremental state to
 * drift, and a reclassified or newly-fixed bug is simply picked up.
 */

export function ensureSzzTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS szz_bug (
      ticket_id   INTEGER PRIMARY KEY,
      status      TEXT    NOT NULL,          -- traced | untraceable | unlinked
      fix_shas    TEXT    NOT NULL,          -- JSON array
      computed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS szz_candidate (
      ticket_id    INTEGER NOT NULL,         -- the bug
      sha          TEXT    NOT NULL,         -- the commit that last wrote some of the fixed lines
      pr_number    INTEGER,
      ticket_ids   TEXT    NOT NULL,         -- JSON array of display ids its subject names
      robot        INTEGER NOT NULL,         -- 1 = its PR was a Robot run's
      committed_at INTEGER NOT NULL,
      lines        INTEGER NOT NULL,
      is_top       INTEGER NOT NULL,         -- 1 = the suspect the charts credit
      PRIMARY KEY (ticket_id, sha)
    );
    CREATE TABLE IF NOT EXISTS szz_pr (
      pr_number INTEGER PRIMARY KEY,         -- every PR squash-merged to main (bugs-per-PR denominator)
      sha       TEXT    NOT NULL,
      merged_at INTEGER NOT NULL,
      robot     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS szz_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

export interface SzzDeps {
  /** Run git in the history clone; returns stdout. */
  git: (args: string[]) => Promise<string>;
  /** Clone or fetch the history clone. */
  refresh: () => Promise<void>;
  now?: number;
}

function defaultDeps(config: AgentWorkerConfig): SzzDeps {
  return {
    git: (args) => gitOutput(args, config, config.szz.historyDir),
    refresh: () => ensureHistoryClone(config),
  };
}

interface BugRow {
  id: number;
  display_id: string;
}

/** Every Robot-opened PR, by ticket — `agent_runs` is worker-owned and may not exist yet. Only
 *  `robot/*` branches: a session PR the Robot adopts (PD-913) keeps the session's branch, and
 *  was written by Steve, so it must not count as Robot-made (PD-925). */
function robotPrsByTicket(db: Database.Database): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  let rows: { ticket_id: number; pr_url: string | null }[] = [];
  try {
    rows = db
      .prepare(
        "SELECT ticket_id, pr_url FROM agent_runs WHERE pr_url IS NOT NULL AND branch LIKE 'robot/%'",
      )
      .all() as typeof rows;
  } catch {
    return out;
  }
  for (const r of rows) {
    const pr = prNumberFromUrl(r.pr_url);
    if (pr === null) continue;
    const set = out.get(r.ticket_id) ?? new Set<number>();
    set.add(pr);
    out.set(r.ticket_id, set);
  }
  return out;
}

/** Blame the lines one fix commit changed in code, on its parent. `touchedCode` is false when
 *  the commit changed no code (a memory or docs commit that merely names the ticket); the tally is
 *  empty when it only added code. */
async function blameFix(
  git: SzzDeps['git'],
  fix: MainCommit,
): Promise<{ touchedCode: boolean; tally: Map<string, number> }> {
  const tally = new Map<string, number>();
  let files: string[];
  try {
    files = (await git(['diff', '--no-renames', '--name-only', `${fix.sha}^`, fix.sha]))
      .split('\n')
      .filter(isCodePath);
  } catch {
    return { touchedCode: false, tally }; // the root commit has no parent: nothing before it to blame
  }
  for (const file of files) {
    let hunks: { start: number; count: number }[];
    try {
      hunks = parseOldHunks(
        await git(['diff', '--no-renames', '-U0', `${fix.sha}^`, fix.sha, '--', file]),
      );
    } catch {
      continue;
    }
    for (const h of hunks) {
      let out: string;
      try {
        out = await git([
          'blame',
          '-w',
          '--line-porcelain',
          '-L',
          `${h.start},+${h.count}`,
          `${fix.sha}^`,
          '--',
          file,
        ]);
      } catch {
        continue; // file absent on the parent (added by the fix) — nothing to blame
      }
      for (const line of parseBlamePorcelain(out)) {
        if (isNoiseLine(line.content)) continue;
        tally.set(line.sha, (tally.get(line.sha) ?? 0) + 1);
      }
    }
  }
  return { touchedCode: files.length > 0, tally };
}

/**
 * One pass. Returns 'skipped' when neither main nor the set of fixed bugs moved since the last
 * pass (the common case for the hourly tick), otherwise the number of bugs analysed.
 */
export async function runSzzPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  deps: SzzDeps = defaultDeps(config),
): Promise<number | 'skipped'> {
  ensureSzzTables(db);
  await deps.refresh();
  const head = (await deps.git(['rev-parse', 'origin/main'])).trim();

  const bugs = db
    .prepare(
      `SELECT t.id, t.display_id FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.kind = 'bug' AND t.is_epic = 0 AND t.archived_at IS NULL AND t.status = 'completed'
          AND t.display_id IS NOT NULL AND p.github_repo = ?
        ORDER BY t.id`,
    )
    .all(config.githubRepo) as BugRow[];
  const signature = `${head}|${bugs.map((b) => b.id).join(',')}`;
  const prev = db.prepare(`SELECT value FROM szz_state WHERE key = 'signature'`).get() as
    { value: string } | undefined;
  if (prev?.value === signature) return 'skipped';

  const commits = parseLog(
    await deps.git(['log', '--first-parent', '--format=%H%x1f%ct%x1f%s', 'origin/main']),
  );
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const robotByTicket = robotPrsByTicket(db);
  const robotPrs = new Set([...robotByTicket.values()].flatMap((s) => [...s]));
  const now = deps.now ?? Date.now();

  const results: {
    bug: BugRow;
    status: SzzStatus;
    fixes: string[];
    candidates: (Candidate & { pr: number | null; tickets: string[]; robot: boolean })[];
    top: string | null;
  }[] = [];

  for (const bug of bugs) {
    const fixes = findFixCommits(
      { displayId: bug.display_id, robotPrs: robotByTicket.get(bug.id) ?? new Set() },
      commits,
    );
    const fixShas = new Set(fixes.map((f) => f.sha));
    const tally = new Map<string, number>();
    const codeFixes: string[] = [];
    for (const fix of fixes) {
      const { touchedCode, tally: t } = await blameFix(deps.git, fix);
      if (touchedCode) codeFixes.push(fix.sha);
      for (const [sha, n] of t) {
        if (fixShas.has(sha)) continue; // an earlier partial fix of the same bug is not its cause
        tally.set(sha, (tally.get(sha) ?? 0) + n);
      }
    }
    const candidates = [...tally].map(([sha, lines]) => {
      // A blamed sha is a first-parent commit on main (squash merges); fall back to its own date.
      const c = bySha.get(sha);
      const pr = c ? prNumberOf(c.subject) : null;
      return {
        sha,
        lines,
        committedAt: c?.committedAt ?? 0,
        pr,
        tickets: c ? ticketIdsIn(c.subject) : [],
        robot: pr !== null && robotPrs.has(pr),
      };
    });
    // Dates for blamed commits not on the first-parent line (rare: a merge commit's side branch).
    for (const c of candidates) {
      if (c.committedAt === 0) {
        c.committedAt =
          Number((await deps.git(['show', '-s', '--format=%ct', c.sha]).catch(() => '0')).trim()) *
          1000;
      }
    }
    const status: SzzStatus =
      codeFixes.length === 0 ? 'unlinked' : candidates.length === 0 ? 'untraceable' : 'traced';
    results.push({
      bug,
      status,
      fixes: codeFixes,
      candidates,
      top: topSuspect(candidates)?.sha ?? null,
    });
  }

  db.transaction(() => {
    db.exec('DELETE FROM szz_bug; DELETE FROM szz_candidate; DELETE FROM szz_pr;');
    const insBug = db.prepare(
      'INSERT INTO szz_bug (ticket_id, status, fix_shas, computed_at) VALUES (?, ?, ?, ?)',
    );
    const insCand = db.prepare(
      `INSERT INTO szz_candidate (ticket_id, sha, pr_number, ticket_ids, robot, committed_at, lines, is_top)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of results) {
      insBug.run(r.bug.id, r.status, JSON.stringify(r.fixes), now);
      for (const c of r.candidates) {
        insCand.run(
          r.bug.id,
          c.sha,
          c.pr,
          JSON.stringify(c.tickets),
          c.robot ? 1 : 0,
          c.committedAt,
          c.lines,
          c.sha === r.top ? 1 : 0,
        );
      }
    }
    const insPr = db.prepare(
      'INSERT OR IGNORE INTO szz_pr (pr_number, sha, merged_at, robot) VALUES (?, ?, ?, ?)',
    );
    for (const c of commits) {
      const pr = prNumberOf(c.subject);
      if (pr !== null) insPr.run(pr, c.sha, c.committedAt, robotPrs.has(pr) ? 1 : 0);
    }
    db.prepare(
      `INSERT INTO szz_state (key, value) VALUES ('signature', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(signature);
  })();

  logger.info(
    {
      bugs: results.length,
      traced: results.filter((r) => r.status === 'traced').length,
      untraceable: results.filter((r) => r.status === 'untraceable').length,
      unlinked: results.filter((r) => r.status === 'unlinked').length,
    },
    'szz: pass complete',
  );
  return results.length;
}
