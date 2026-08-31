import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The decision log, as one file per decision (PD-490, D-070).
 *
 * `DECISIONS/D-NNN-slug.md` holds the prose; `DECISIONS.md` is a GENERATED index over it.
 * Two agents writing two different decisions touch two different files, so git merges them
 * with no conflict — which is the whole point, because the alternative was an unsupervised
 * agent resolving a merge conflict in the project's decision record.
 *
 * ## The number collision is NOT solved by the filename
 *
 * It is tempting to think that letting each author claim the next free `D-NNN` turns a silent
 * collision into a loud add/add filename conflict. It does not. Git only reports add/add when
 * the paths are *identical*, and the path carries a slug:
 *
 *     branch A: DECISIONS/D-070-evaluator-runs-post-pr.md
 *     branch B: DECISIONS/D-070-rate-limit-is-a-fault-tier.md
 *
 * Different paths. Git merges both, cleanly and silently, and the log has two D-070s — exactly
 * the failure that already happened to **D-056** (see that file's header note). The filename
 * makes conflicts *rarer*, which makes an undetected duplicate *more* likely, not less.
 *
 * So the guard is not the filesystem, it is {@link loadDecisions} throwing on a duplicate id,
 * asserted by a test that runs over the real `DECISIONS/` on every CI run. The merge itself is
 * allowed to succeed; the merge *result* is what fails. That is the only check that sees both
 * branches at once.
 *
 * ## Nobody claims a number at authoring time any more (D-078)
 *
 * That guard is detection, not prevention, and `strict: false` branch protection lets two PRs go
 * green against merge bases that exclude each other and both land. So authors no longer pick a
 * number at all: a decision is written into {@link INCOMING_DIR} under a **provisional id**
 * (`D-TMP-EG513a`) and a later numbering cycle assigns its `D-NNN` in merge order. Two provisional
 * decisions cannot collide, because neither carries a number.
 *
 * The duplicate-id throw below stays as belt-and-braces over the numbered log.
 */
export interface Decision {
  /** Canonical citation form, zero-padded: `D-046`. This is what the other ~1,000 references say. */
  id: string;
  /** Numeric form, for ordering. */
  num: number;
  /** Filename slug — cosmetic, and deliberately not part of the identity. */
  slug: string;
  /** First-line heading text, minus the `# D-NNN: ` prefix. Doubles as the index's summary line. */
  title: string;
  /** Path relative to the repo root, e.g. `DECISIONS/D-046-sortie-after-run-safety-net.md`. */
  file: string;
}


export const DECISIONS_DIR = 'DECISIONS';
export const DECISIONS_INDEX = 'DECISIONS.md';

/**
 * Walk up from `start` to the repo root — the directory that holds both `DECISIONS/` and
 * `DECISIONS.md`.
 *
 * Not `import.meta.url` (this package typechecks as CommonJS) and not a fixed `../../..` from
 * `process.cwd()`, because the two callers have different working directories: the npm script runs
 * with cwd at `apps/agent-worker`, vitest at the workspace root. Searching for the thing we need is
 * indifferent to both.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, DECISIONS_DIR)) && existsSync(path.join(dir, DECISIONS_INDEX))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no repo root above ${start}: found no directory with both ${DECISIONS_DIR}/ and ${DECISIONS_INDEX}`);
    dir = parent;
  }
}

/** `D-046-some-slug.md` → `{ num: 46, slug: 'some-slug' }`. Returns null for anything else. */
export function parseDecisionFilename(filename: string): { num: number; slug: string } | null {
  const m = /^D-(\d{3})-([a-z0-9][a-z0-9-]*)\.md$/.exec(filename);
  if (!m) return null;
  return { num: Number(m[1]), slug: m[2] };
}

/** `# D-046: Title here` → `{ num: 46, title: 'Title here' }`. Returns null for anything else. */
export function parseDecisionHeading(contents: string): { num: number; title: string } | null {
  const first = contents.split('\n', 1)[0] ?? '';
  const m = /^# D-(\d{3}):\s*(\S.*?)\s*$/.exec(first);
  if (!m) return null;
  return { num: Number(m[1]), title: m[2] };
}


/**
 * Read every decision in `DECISIONS/`, newest first.
 *
 * Throws — loudly, with the offending paths named — on anything that would corrupt the log:
 * a file that is not `D-NNN-slug.md`, a heading that disagrees with its own filename (the
 * copy-paste-a-neighbouring-decision mistake), or two files claiming the same `D-NNN`.
 */
export function loadDecisions(repoRoot: string): Decision[] {
  const dir = path.join(repoRoot, DECISIONS_DIR);
  const decisions: Decision[] = [];
  const byNum = new Map<number, string>();

  for (const filename of readdirSync(dir).sort()) {
    if (!filename.endsWith('.md')) continue;
    const parsed = parseDecisionFilename(filename);
    if (!parsed) {
      throw new Error(
        `${DECISIONS_DIR}/${filename}: filename must be D-NNN-slug.md (zero-padded number, lowercase hyphenated slug)`,
      );
    }
    const file = `${DECISIONS_DIR}/${filename}`;
    const heading = parseDecisionHeading(readFileSync(path.join(dir, filename), 'utf8'));
    if (!heading) {
      throw new Error(`${file}: first line must be a "# D-NNN: Title" heading`);
    }
    if (heading.num !== parsed.num) {
      throw new Error(
        `${file}: heading says D-${String(heading.num).padStart(3, '0')} but the filename says D-${String(parsed.num).padStart(3, '0')}`,
      );
    }
    const clash = byNum.get(parsed.num);
    if (clash !== undefined) {
      throw new Error(
        `D-${String(parsed.num).padStart(3, '0')} is claimed twice: ${clash} and ${file}. ` +
          `Two branches allocated the same number and git merged both because the filenames differ. ` +
          `Renumber the newer one to the next free id and update any references to it.`,
      );
    }
    byNum.set(parsed.num, file);
    decisions.push({ id: `D-${String(parsed.num).padStart(3, '0')}`, num: parsed.num, slug: parsed.slug, title: heading.title, file });
  }

  return decisions.sort((a, b) => b.num - a.num);
}


/**
 * Render `DECISIONS.md` — the **committed** index.
 *
 * Deliberately id + title + link and nothing else: every field here is a field that can drift
 * from the file it describes, and the titles in this log are already written as full sentences,
 * so the title *is* the one-line summary. There is no date column for the same reason — the
 * numbering is chronological, and `git log --diff-filter=A` has the real answer.
 *
 * ## Numbered decisions only, and that is the point (PD-551)
 *
 * Provisional decisions are **not** in this file. They were, briefly, and it put the merge conflict
 * straight back: every authoring PR regenerated the index and inserted a line into the same block,
 * so two concurrent authors collided on a generated file — the exact failure D-070 removed and
 * D-078 claimed to have retired.
 *
 * PD-560 collapsed that split rather than resolving it. Ids are allocated at authoring time now, so
 * a decision is listed here the moment it merges and there is no second, injected variant of the
 * index: the file agents read is the file humans read. The collision the provisional scheme was
 * avoiding is handled upstream, by the counter, instead of by keeping rows out of this file.
 */
export function renderDecisionsIndex(decisions: readonly Decision[]): string {
  const lines = [
    '# Decision Log',
    '',
    'Captures the _why_ behind key choices made during planning. Useful when revisiting a decision later — if a choice no longer fits, the original reasoning makes it easier to see what changed and whether to revisit.',
    '',
    `**This file is generated — do not edit it by hand.** Each decision is its own file in \`${DECISIONS_DIR}/\`;`,
    'this is the index over them. Regenerate it with `npm run decisions:index`.',
    '',
    '**To add a decision, ask for an id first.** `POST /api/decisions/allocate` returns the next',
    '`D-NNN`, and that counter is the only thing that ever hands one out. Write',
    '`DECISIONS/D-NNN-<slug>.md` with `# D-NNN: Title` as its first line, and cite `D-NNN` in code',
    'straight away.',
    '',
    '**Never pick a number yourself** — not even in a session you are sure is the only one running.',
    'A number chosen by reading this file is the `max + 1` that produced the D-056 and D-065',
    'collisions (D-070, D-087).',
    '',
    'Newest first.',
    '',
    '---',
    '',
    ...decisions.map((d) => `- **[${d.id}](${d.file})** — ${d.title}`),
    '',
  ];
  return lines.join('\n');
}
