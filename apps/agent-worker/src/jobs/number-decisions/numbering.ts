import type { Decision, ProvisionalDecision } from '../../shared/decisions';
import { DECISIONS_DIR } from '../../shared/decisions';

/**
 * The pure core of the decision-numbering cycle (PD-498, D-078): given the numbered log and the
 * inbox, decide what each provisional decision becomes.
 *
 * Everything here is a pure function of its inputs — no git, no fs, no clock. The orchestration in
 * `cycle.ts` does the side effects. That split is deliberate: the risky part of this job is not
 * running `gh`, it is getting the *renames and the rewrite* right, and that is the part a test can
 * pin down exactly.
 */

/** One provisional decision and the identity it is about to take on. */
export interface Assignment {
  /** The provisional decision being numbered. */
  from: ProvisionalDecision;
  /** Its new canonical id, e.g. `D-080`. */
  id: string;
  /** Numeric form. */
  num: number;
  /** The slug derived from its title. */
  slug: string;
  /** Where the file moves to, e.g. `DECISIONS/D-080-some-slug.md`. */
  file: string;
}

/**
 * Longest slug the cycle will generate.
 *
 * Decision titles here run long and often carry a parenthetical (`… (PD-383; amends D-054, D-058)`),
 * so an unbounded slug produces 120-character filenames. Truncation is at a word boundary so the
 * result still reads as words rather than a severed one.
 */
export const MAX_SLUG_LENGTH = 60;

/**
 * Title → filename slug, matching what `parseDecisionFilename` accepts: lowercase, digits, hyphens,
 * starting with an alphanumeric.
 *
 * The slug is explicitly cosmetic (see `Decision.slug`), which is what makes deriving it safe: it is
 * not part of the decision's identity, so nothing breaks if a human would have chosen better words.
 * The alternative — asking the author for a slug alongside the provisional id — puts a second thing
 * to get right at authoring time, which is what D-078 was reducing.
 */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[’'`]/g, '') // elide apostrophes rather than splitting the word around them
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= MAX_SLUG_LENGTH) return base || 'decision';
  const cut = base.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = cut.lastIndexOf('-');
  // Only fall back to a hard cut if the first "word" is itself longer than the limit.
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '') || 'decision';
}

/**
 * Assign `D-NNN`s to `provisional`, in the order given, starting one past the highest number the
 * numbered log already claims.
 *
 * **Order is the caller's to establish, and it means merge order** (D-078). `cycle.ts` reads it from
 * git — the commit that ADDED each inbox file — because number order is meant to be chronological,
 * and the inbox's own filename order is alphabetical by ticket, which is not the same thing. Passing
 * an arbitrary order here is allowed and produces a consistent result; it just would not be
 * chronological.
 *
 * Numbers are allocated from the highest, never into gaps, for the reason `nextDecisionId` gives:
 * back-filling a gap would put a newer decision before an older one in the log's own ordering.
 */
export function assignNumbers(
  numbered: readonly Decision[],
  provisional: readonly ProvisionalDecision[],
): Assignment[] {
  let next = numbered.reduce((max, d) => Math.max(max, d.num), 0) + 1;
  return provisional.map((from) => {
    const num = next++;
    const id = `D-${String(num).padStart(3, '0')}`;
    const slug = slugify(from.title);
    return { from, id, num, slug, file: `${DECISIONS_DIR}/${id}-${slug}.md` };
  });
}

/**
 * Rewrite every `D-TMP-…` citation in `text` to its assigned `D-NNN`.
 *
 * Safe as a blind whole-repo pass because the namespaces cannot overlap: `D-TMP-` can never match
 * `D-\d{3}`, which is the property D-078 chose the prefix for.
 *
 * Ids are not prefix-free (`D-TMP-PD38a` is a prefix of `D-080` as plain text), so the match
 * must not be a per-id search-and-replace. Matching the whole `[A-Za-z0-9]+` tail greedily and
 * looking the result up is what keeps the shorter id from corrupting the longer one.
 *
 * An UNASSIGNED `D-TMP-` id is left exactly as it is. That is the honest behaviour: it means a
 * citation refers to a decision that is not in the inbox — a typo, or a file deleted without its
 * citations — and quietly rewriting it to something plausible would bury that. {@link danglingIds}
 * finds them so the cycle can report them.
 */
export function rewriteCitations(text: string, assignments: readonly Assignment[]): string {
  const byId = new Map(assignments.map((a) => [a.from.id, a.id]));
  return text.replace(/D-TMP-[A-Za-z0-9]+/g, (match) => byId.get(match) ?? match);
}

/** Every `D-TMP-` id cited in `text` that no assignment covers — a citation with nothing behind it. */
export function danglingIds(text: string, assignments: readonly Assignment[]): string[] {
  const known = new Set(assignments.map((a) => a.from.id));
  const found = new Set<string>();
  for (const m of text.matchAll(/D-TMP-[A-Za-z0-9]+/g)) if (!known.has(m[0])) found.add(m[0]);
  return [...found].sort();
}

/**
 * The first line of a numbered decision file, rewritten from its provisional heading.
 *
 * Only the id changes; the title is carried across verbatim. The heading and the filename have to
 * agree or `loadDecisions` throws, so this and {@link assignNumbers} are two halves of one rule.
 */
export function renumberHeading(contents: string, assignment: Assignment): string {
  const lines = contents.split('\n');
  lines[0] = `# ${assignment.id}: ${assignment.from.title}`;
  return lines.join('\n');
}
