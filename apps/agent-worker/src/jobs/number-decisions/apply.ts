import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { danglingIds, renumberHeading, rewriteCitations, type Assignment } from './numbering';

/**
 * Applying a set of {@link Assignment}s to a working tree (PD-498, D-078): move each provisional
 * decision to its numbered path, fix its heading, and rewrite every `D-TMP-` citation repo-wide.
 *
 * Split from `numbering.ts` so the decisions stay pure and only the fs touching lives here, and from
 * `cycle.ts` so this can be run against a fixture tree in a test without any git or `gh` at all.
 */

/**
 * Directories never walked when rewriting citations.
 *
 * `node_modules` and `.git` are the obvious ones (volume, and rewriting git's own object store would
 * be catastrophic). `.claude/worktrees` matters here specifically: this repo keeps its worktrees
 * INSIDE the checkout, so a naive walk from the repo root would descend into every other in-flight
 * session's tree and rewrite files on their branches.
 */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', 'coverage', 'worktrees']);

/**
 * Extensions whose contents are rewritten. A citation only ever lives in prose or source, and an
 * allowlist beats a denylist here: a stray binary that happens to contain the byte sequence
 * `D-TMP-…` would otherwise be corrupted by a blind write.
 */
export const REWRITE_EXTENSIONS = new Set(['.md', '.ts', '.js', '.mjs', '.svelte', '.scss', '.json', '.yml', '.yaml', '.txt', '.sh']);

/** Every rewritable file under `root`, repo-relative, depth-first and sorted for determinism. */
export function rewritableFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...rewritableFiles(root, abs));
    } else if (REWRITE_EXTENSIONS.has(path.extname(entry))) {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}

export interface ApplyResult {
  /** Repo-relative paths whose contents changed. */
  rewritten: string[];
  /** `{ from, to }` for each decision file moved out of the inbox. */
  moved: { from: string; to: string }[];
  /** `D-TMP-` ids cited somewhere in the tree with no decision behind them, sorted. */
  dangling: string[];
}

/**
 * Apply `assignments` to the tree at `root`, in place.
 *
 * Order matters and is the one subtle thing here: each decision file is **moved and renumbered
 * first**, then the whole tree — including the file at its new path — gets the citation rewrite. A
 * decision that cites another provisional decision (they do) is therefore fixed by the same pass
 * that fixes everyone else's citation of it, rather than needing a special case.
 *
 * Dangling citations are reported, never rewritten. See {@link rewriteCitations}.
 */
export function applyAssignments(root: string, assignments: readonly Assignment[]): ApplyResult {
  const moved: { from: string; to: string }[] = [];

  for (const assignment of assignments) {
    const fromAbs = path.join(root, assignment.from.file);
    const toAbs = path.join(root, assignment.file);
    writeFileSync(fromAbs, renumberHeading(readFileSync(fromAbs, 'utf8'), assignment), 'utf8');
    renameSync(fromAbs, toAbs);
    moved.push({ from: assignment.from.file, to: assignment.file });
  }

  const rewritten: string[] = [];
  const dangling = new Set<string>();

  for (const rel of rewritableFiles(root)) {
    const abs = path.join(root, rel);
    const before = readFileSync(abs, 'utf8');
    if (!before.includes('D-TMP-')) continue;
    for (const id of danglingIds(before, assignments)) dangling.add(id);
    const after = rewriteCitations(before, assignments);
    if (after !== before) {
      writeFileSync(abs, after, 'utf8');
      rewritten.push(rel);
    }
  }

  return { rewritten, moved, dangling: [...dangling].sort() };
}
