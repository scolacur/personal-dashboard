import { DECISION_SEED_MODULE, DECISIONS_INDEX } from '../../shared/decisions';

/**
 * Which merge conflicts are mechanical enough to resolve with no human and no Robot run (PD-774, D-099).
 *
 * Pure: it sees a conflicted file's path, git's unmerged status and its diff3-marked content, and
 * returns a verdict. The resolver acts on it; nothing here touches git.
 *
 * The allow-list, and nothing else:
 *  - **generated files** (the decision index and its seed module) are regenerated from their
 *    sources, as CLAUDE.md already tells a human to;
 *  - **append-only hunks**: both sides inserted lines at the same point and neither changed what
 *    was there (diff3's base section is empty). The union keeps both, main's lines first, since
 *    main's landed first.
 * A sensitive path (`.github/sensitive-paths.txt`) is refused even when its shape qualifies: its
 * changes need Steve's conscious ack (D-047), and a robot rewriting one would bypass that.
 */

export type ConflictVerdict =
  | { kind: 'regenerate'; path: string }
  | { kind: 'union'; path: string; content: string }
  | { kind: 'refuse'; path: string; reason: string };

/** Git pathspec-style glob → RegExp: a double star crosses directories (and a leading double-star-slash also matches a file at the root); a single star does not. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** The globs of `.github/sensitive-paths.txt`: one per line, `#` comments and blanks ignored. */
export function parseSensitivePaths(text: string): RegExp[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map(globToRegExp);
}

export const GENERATED_FILES: readonly string[] = [DECISIONS_INDEX, DECISION_SEED_MODULE];

const OURS = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const THEIRS = /^>{7}(?: |$)/;

/**
 * Resolve a diff3-marked file whose every hunk is append-only, or return null when any hunk is not
 * (or the markers are malformed). `ours` is the PR branch, `theirs` is main.
 */
export function unionAppendOnly(content: string): string | null {
  const lines = content.split('\n');
  const out: string[] = [];
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!OURS.test(lines[i])) {
      if (BASE.test(lines[i]) || SPLIT.test(lines[i]) || THEIRS.test(lines[i])) return null;
      out.push(lines[i]);
      continue;
    }
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !BASE.test(lines[j]); j++) {
      if (OURS.test(lines[j]) || SPLIT.test(lines[j]) || THEIRS.test(lines[j])) return null;
      ours.push(lines[j]);
    }
    if (j >= lines.length) return null; // no base section: not diff3, so append-only is unknowable
    for (j++; j < lines.length && !SPLIT.test(lines[j]); j++) {
      if (OURS.test(lines[j]) || BASE.test(lines[j]) || THEIRS.test(lines[j])) return null;
      base.push(lines[j]);
    }
    if (j >= lines.length) return null;
    for (j++; j < lines.length && !THEIRS.test(lines[j]); j++) {
      if (OURS.test(lines[j]) || BASE.test(lines[j]) || SPLIT.test(lines[j])) return null;
      theirs.push(lines[j]);
    }
    if (j >= lines.length) return null;
    // Append-only: nothing existed here before, and both sides added something.
    if (base.length !== 0 || ours.length === 0 || theirs.length === 0) return null;
    out.push(...theirs, ...ours);
    hunks++;
    i = j;
  }
  return hunks > 0 ? out.join('\n') : null;
}

/**
 * The verdict for one conflicted file. `status` is the two-letter unmerged code from
 * `git status --porcelain` (UU both modified, AA both added, DU/UD/AU/UA/DD the delete/add shapes);
 * `content` is the working-tree file with diff3 markers, null when it does not exist.
 */
export function classifyConflict(
  path: string,
  status: string,
  content: string | null,
  sensitive: readonly RegExp[],
): ConflictVerdict {
  if (sensitive.some((re) => re.test(path))) {
    return { kind: 'refuse', path, reason: 'sensitive path: needs Steve' };
  }
  if (GENERATED_FILES.includes(path)) return { kind: 'regenerate', path };
  if (status !== 'UU' || content === null) {
    return { kind: 'refuse', path, reason: `not a both-modified text conflict (${status})` };
  }
  const merged = unionAppendOnly(content);
  if (merged === null) return { kind: 'refuse', path, reason: 'both sides changed the same lines' };
  return { kind: 'union', path, content: merged };
}

/** Unmerged entries from `git status --porcelain=v1` output. */
export function unmergedFromStatus(porcelain: string): { status: string; path: string }[] {
  const UNMERGED = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  return porcelain
    .split('\n')
    .filter((l) => l.length > 3 && UNMERGED.has(l.slice(0, 2)))
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3).replace(/^"(.*)"$/, '$1') }));
}
