/**
 * SZZ, the pure half (PD-916): parse git output, link a bug to its fix commits, filter blamed
 * lines, and pick the top suspect. No git, no DB — `pass.ts` feeds these from both.
 *
 * SZZ (Śliwerski, Zimmermann, Zeller 2005): the lines a fix changed or deleted were, most likely,
 * where the bug lived; `git blame` on the fix's parent names the commits that last wrote them.
 * Those are the bug-introducing *candidates* — suspects, not proof.
 */

/** One first-parent commit on main: on this repo, one squash-merged PR (or a direct push). */
export interface MainCommit {
  sha: string;
  subject: string;
  /** Committer time, unix ms. */
  committedAt: number;
}

/** `git log --first-parent --format=%H%x1f%ct%x1f%s` → commits, newest first as git prints them. */
export function parseLog(out: string): MainCommit[] {
  const commits: MainCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [sha, ct, ...rest] = line.split('\x1f');
    if (!sha || !ct) continue;
    commits.push({ sha, committedAt: Number(ct) * 1000, subject: rest.join('\x1f') });
  }
  return commits;
}

/** The PR a squash commit came from — GitHub appends `(#123)` to the subject. */
export function prNumberOf(subject: string): number | null {
  const all = [...subject.matchAll(/\(#(\d+)\)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/** Ticket display ids a subject names (`PD-784`, `C-12`); decision ids (`D-104`) excluded. */
export function ticketIdsIn(subject: string): string[] {
  const ids = [...subject.matchAll(/\b([A-Z]{1,4})-(\d+)\b/g)]
    .map((m) => `${m[1]}-${m[2]}`)
    .filter((id) => !/^D-\d+$/.test(id));
  return [...new Set(ids)];
}

/** The PR number in a GitHub PR URL (`agent_runs.pr_url`). */
export function prNumberFromUrl(url: string | null): number | null {
  const m = url ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

const CODE_EXT = /\.(ts|js|mjs|cjs|svelte|scss|sql|ya?ml|sh)$/;

/**
 * Whether a path is code a bug can live in. Tests are excluded: a fix rewriting an assertion is
 * not evidence about where the bug was. So are the memory / decision logs and prose.
 */
export function isCodePath(p: string): boolean {
  if (!CODE_EXT.test(p)) return false;
  if (/\.(spec|test)\.[a-z]+$/.test(p)) return false;
  if (p.startsWith('MEMORY/') || p.startsWith('DECISIONS')) return false;
  return true;
}

/**
 * The commits on main that fixed a bug: those whose subject names its display id, or whose PR is
 * one of the bug's Robot runs (a Robot PR's subject may not carry the id). Whether a commit
 * touched code at all is checked later, against its file list.
 */
export function findFixCommits(
  bug: { displayId: string; robotPrs: ReadonlySet<number> },
  commits: readonly MainCommit[],
): MainCommit[] {
  const idRe = new RegExp(`\\b${bug.displayId.replace('-', '\\-')}\\b`);
  return commits.filter((c) => {
    if (idRe.test(c.subject)) return true;
    const pr = prNumberOf(c.subject);
    return pr !== null && bug.robotPrs.has(pr);
  });
}

/** Old-side ranges of a `git diff -U0` — the lines the fix changed or deleted. Pure additions
 *  (`-a,0`) have no old lines and are skipped: nothing there was wrong, something was missing. */
export function parseOldHunks(diff: string): { start: number; count: number }[] {
  const hunks: { start: number; count: number }[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) hunks.push({ start: Number(m[1]), count });
  }
  return hunks;
}

/** `git blame --line-porcelain` → one { sha, content } per blamed line. */
export function parseBlamePorcelain(out: string): { sha: string; content: string }[] {
  const lines: { sha: string; content: string }[] = [];
  let sha = '';
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) sha = header[1];
    else if (line.startsWith('\t')) lines.push({ sha, content: line.slice(1) });
  }
  return lines;
}

/** A blamed line that says nothing about behaviour: blank, punctuation-only, or a comment. */
export function isNoiseLine(content: string): boolean {
  const t = content.trim();
  if (t === '') return true;
  if (/^[{}()[\];,]+$/.test(t)) return true;
  return /^(\/\/|\/\*|\*|<!--|#(?!!))/.test(t);
}

export interface Candidate {
  sha: string;
  lines: number;
  committedAt: number;
}

/** The suspect credited with the bug: most blamed lines; a tie goes to the most recent commit,
 *  the likelier one to have changed behaviour rather than to have first laid the code down. */
export function topSuspect(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (
      !best ||
      c.lines > best.lines ||
      (c.lines === best.lines && c.committedAt > best.committedAt)
    ) {
      best = c;
    }
  }
  return best;
}

/** Outcome for one fixed bug. */
export type SzzStatus = 'traced' | 'untraceable' | 'unlinked';
