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

/**
 * A decision that has merged but has not been numbered yet (D-078).
 *
 * Settled and binding — "provisional" attaches to the *identifier*, not the authority. It is cited
 * as `D-TMP-EG513a` everywhere until the numbering cycle rewrites those citations to a `D-NNN`.
 */
export interface ProvisionalDecision {
  /** Citation form: `D-TMP-EG513a`. Namespaced so it can never match `D-\d{3}`. */
  id: string;
  /** The authoring ticket, digits only for ordering: `513`. */
  ticketNum: number;
  /** Ticket prefix, e.g. `PD` — one repo today, but the id does not assume it. */
  ticketPrefix: string;
  /** Disambiguates one ticket producing two decisions: `a`, `b`, … */
  letter: string;
  /** First-line heading text, minus the `# D-TMP-…: ` prefix. */
  title: string;
  /** Path relative to the repo root, e.g. `DECISIONS/incoming/D-TMP-EG383a.md`. */
  file: string;
}

export const DECISIONS_DIR = 'DECISIONS';
export const DECISIONS_INDEX = 'DECISIONS.md';
/**
 * The decision inbox (D-078). Every decision is authored here, including by a solo human session.
 *
 * It sits *inside* `DECISIONS/` on purpose and costs {@link loadDecisions} nothing: that function
 * skips any entry not ending in `.md`, so a directory is invisible to it. A provisional file placed
 * directly in `DECISIONS/` would instead throw and break `npm run decisions:index` for everyone.
 */
export const INCOMING_DIR = `${DECISIONS_DIR}/incoming`;

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
 * The ticket prefix reserved for examples and test fixtures — `D-TMP-EG513a` (PD-548).
 *
 * **Why a reserved prefix and not a convention.** The numbering cycle rewrites `D-TMP-` citations
 * by walking the whole repo, and it cannot tell a citation from a fixture that looks like one. On
 * 2026-08-23 it proved that: the fixtures in the tests below cited a provisional id that was also a
 * real decision in the inbox, so the cycle rewrote it *inside the string literals of the very tests
 * that verify rewriting*. Correctly, by its own rules — which is the point. The fixtures came out
 * half-renamed and `verify` went red (closed PR #361). The same ambiguity made the
 * dangling-citation report 100% false positives on its first run: every id it flagged was an
 * example.
 *
 * **This is a fix for a mechanism that is itself being removed.** Epic PD-556 allocates decision
 * ids at authoring time, which deletes the rewrite and with it the reason a fixture id was ever
 * dangerous. Until that lands, the cycle cannot number anything without this.
 *
 * So examples get a namespace that is **structurally** not a real ticket. `EG` is not a project
 * prefix and never will be, which makes "is this a real citation?" a lookup rather than a judgement.
 * {@link isExampleId} is what tells the dangling report to stay quiet about them.
 *
 * **The rule that keeps this working: no decision is ever authored under `EG`.** That would give the
 * rewriter a real mapping for an id every doc and fixture uses freely — the exact collision the
 * prefix removes. It is enforced by a test over the real inbox rather than by
 * {@link loadProvisionalDecisions}, because the loader is also what the tests point at a temp inbox
 * full of deliberately-`EG` fixtures. A guard in the loader would forbid the fixtures it exists to
 * make safe.
 */
export const EXAMPLE_TICKET_PREFIX = 'EG';

/** True for a reserved example id like `D-TMP-EG513a` — never a real decision, never rewritten. */
export function isExampleId(id: string): boolean {
  return parseProvisionalId(id)?.ticketPrefix === EXAMPLE_TICKET_PREFIX;
}

/**
 * `D-TMP-EG383a.md` → `{ id: 'D-TMP-EG383a', ticketPrefix: 'EG', ticketNum: 383, letter: 'a' }`.
 * Returns null for anything else.
 *
 * No slug, unlike a numbered decision: the id is already unique and the file is short-lived, so a
 * slug would only be one more thing for the rename to carry. The trailing letter is what covers one
 * ticket producing two decisions.
 */
export function parseProvisionalId(text: string): Omit<ProvisionalDecision, 'title' | 'file'> | null {
  const m = /^D-TMP-([A-Z]{1,6})(\d{1,5})([a-z])$/.exec(text);
  if (!m) return null;
  return { id: text, ticketPrefix: m[1], ticketNum: Number(m[2]), letter: m[3] };
}

/** `D-TMP-EG383a.md` → the parsed id. Returns null for anything else. */
export function parseProvisionalFilename(filename: string): Omit<ProvisionalDecision, 'title' | 'file'> | null {
  if (!filename.endsWith('.md')) return null;
  return parseProvisionalId(filename.slice(0, -'.md'.length));
}

/** `# D-TMP-EG383a: Title here` → `{ id, title }`. Returns null for anything else. */
export function parseProvisionalHeading(
  contents: string,
): (Omit<ProvisionalDecision, 'title' | 'file'> & { title: string }) | null {
  const first = contents.split('\n', 1)[0] ?? '';
  const m = /^# (D-TMP-[A-Za-z0-9]+):\s*(\S.*?)\s*$/.exec(first);
  if (!m) return null;
  const parsed = parseProvisionalId(m[1]);
  return parsed && { ...parsed, title: m[2] };
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
 * Read every provisional decision in `DECISIONS/incoming/`, oldest ticket first — the order the
 * numbering cycle will assign `D-NNN`s in, absent better merge-order information.
 *
 * A missing directory is not an error: the inbox is empty for as long as it takes the next author
 * to write into it, and git cannot track an empty directory in the first place (hence `.gitkeep`).
 *
 * Throws on a `.md` file that is not a well-formed provisional decision, for the same reason
 * {@link loadDecisions} does: a file nobody can parse is a decision nobody will ever number, and it
 * would sit in the inbox indefinitely with no signal.
 */
export function loadProvisionalDecisions(repoRoot: string): ProvisionalDecision[] {
  const dir = path.join(repoRoot, INCOMING_DIR);
  if (!existsSync(dir)) return [];
  const decisions: ProvisionalDecision[] = [];

  for (const filename of readdirSync(dir).sort()) {
    if (!filename.endsWith('.md')) continue;
    const file = `${INCOMING_DIR}/${filename}`;
    const parsed = parseProvisionalFilename(filename);
    if (!parsed) {
      throw new Error(
        `${file}: filename must be D-TMP-<TICKET><letter>.md, e.g. D-TMP-EG513a.md ` +
          `(uppercase ticket prefix, no slug, a single lowercase letter). Numbered decisions go in ${DECISIONS_DIR}/, not here.`,
      );
    }
    const heading = parseProvisionalHeading(readFileSync(path.join(dir, filename), 'utf8'));
    if (!heading) {
      throw new Error(`${file}: first line must be a "# ${parsed.id}: Title" heading`);
    }
    if (heading.id !== parsed.id) {
      throw new Error(`${file}: heading says ${heading.id} but the filename says ${parsed.id}`);
    }
    decisions.push({ ...parsed, title: heading.title, file });
  }

  return decisions.sort((a, b) => a.ticketPrefix.localeCompare(b.ticketPrefix) || a.ticketNum - b.ticketNum || a.letter.localeCompare(b.letter));
}

/**
 * One past the highest `D-NNN` any file has claimed.
 *
 * Not "the lowest free id" — gaps are left alone. The numbering cycle (D-078) assigns from the
 * highest so that number order stays merge order; back-filling a gap would put a newer decision
 * before an older one and quietly break that.
 *
 * This is now the *cycle's* allocator, not an author's: nobody claims a number at authoring time.
 */
export function nextDecisionId(decisions: readonly Decision[]): string {
  const highest = decisions.reduce((max, d) => Math.max(max, d.num), 0);
  return `D-${String(highest + 1).padStart(3, '0')}`;
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
 * With them out, an authoring PR touches only its own uniquely-named file in `incoming/` and no
 * shared file at all. The committed index changes only when the consolidation cycle numbers
 * something, and only one cycle ever runs.
 *
 * Agents still see provisional decisions — see {@link renderInjectedIndex}, which is what actually
 * reaches them. This function is what gets written to disk; that one is what gets read aloud.
 */
export function renderDecisionsIndex(decisions: readonly Decision[]): string {
  const lines = [
    '# Decision Log',
    '',
    'Captures the _why_ behind key choices made during planning. Useful when revisiting a decision later — if a choice no longer fits, the original reasoning makes it easier to see what changed and whether to revisit.',
    '',
    `**This file is generated — do not edit it by hand.** Each decision is its own file in \`${DECISIONS_DIR}/\`;`,
    `this is the index over them. To add one, write \`${INCOMING_DIR}/D-TMP-<TICKET><letter>.md\` — never a`,
    '`D-NNN` file by hand — and cite it by that provisional id.',
    '',
    `**Decisions awaiting a number are NOT listed here.** They live in \`${INCOMING_DIR}/\` and are just as`,
    'settled and binding; read that directory alongside this file. They are deliberately kept out so that',
    'authoring one touches no shared file and two authors can never collide on this index (D-070, D-078,',
    'PD-551). The consolidation cycle adds them here when it assigns their numbers.',
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

/**
 * The `## Awaiting a number` block: merged, binding decisions that have not been numbered yet.
 *
 * Rendered on demand rather than committed, so it costs no shared file. Empty string when the inbox
 * is empty, so a caller can concatenate unconditionally.
 */
export function renderProvisionalSection(provisional: readonly ProvisionalDecision[]): string {
  if (provisional.length === 0) return '';
  return [
    '',
    '## Awaiting a number',
    '',
    'Merged, settled, and binding — cite them as they are. Only the *identifier* is provisional:',
    'the consolidation cycle assigns each one a `D-NNN` and rewrites these citations (D-078).',
    '',
    ...provisional.map((d) => `- **[${d.id}](${d.file})** — ${d.title}`),
    '',
  ].join('\n');
}

/**
 * The index as an **agent** should see it (D-071): the committed file plus the provisional block.
 *
 * This is the function the orientation builder must call. A decision that merged an hour ago is
 * binding, and an agent that cannot see it will re-litigate it — which is the failure item 3 of
 * D-078 exists to prevent. Keeping the two renderers separate is what lets the committed file stay
 * conflict-free without making merged decisions invisible.
 */
export function renderInjectedIndex(
  decisions: readonly Decision[],
  provisional: readonly ProvisionalDecision[],
): string {
  return renderDecisionsIndex(decisions) + renderProvisionalSection(provisional);
}
