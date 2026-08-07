# D-070: One decision per file, with a generated index and a duplicate-id test as the real guard (PD-490)

**Decision:** each decision is its own file, `DECISIONS/D-NNN-slug.md`, and `DECISIONS.md` is a
**generated** index over them (`npm run decisions:index`). `D-NNN` is kept exactly as-is — no
renumbering, no scheme change — because it is the densest cross-reference in the repo. An author
claims the next free number by writing the file; the thing that *catches* a double-claim is not the
filesystem but `loadDecisions()` throwing on a duplicate id, asserted by a test that runs over the
real `DECISIONS/` on every CI run. Same shape as `MEMORY/` — day files plus an index — applied to
decisions.

**Reasoning:**

- **Two problems get conflated here, and only one is about numbering.** *Allocation collision* —
  two sessions claim the same `D-NNN` — is caused by the sequential scheme. *Text conflict* — two
  sessions inserting prose into the same region of one file — is caused by the single-file layout
  and is completely indifferent to what the identifiers look like. Timestamp ids would fix the
  first and not touch the second. Splitting the file fixes the second, and needs a separate,
  explicit mechanism for the first. This decision does both, separately.
- **The filename does not solve the collision, and believing it does is the trap.** The appealing
  story is that letting each author take the next free number converts a silent collision into a
  loud add/add conflict. Git only reports add/add when the paths are *identical*, and the path
  carries a slug: `D-070-evaluator-post-pr.md` and `D-070-rate-limit-fault-tier.md` are different
  paths, so git merges both, cleanly and silently, and the log has two D-070s. Splitting the file
  makes text conflicts vanish, which makes an undetected duplicate *more* likely than it is today,
  not less. The guard has to be a check that sees the merge *result* — which is a test, running in
  CI, over the merged tree. The merge is allowed to succeed; the merged tree is what fails.
- **This is not hypothetical; it already happened and stayed broken for three weeks.** PR #235 and
  PR #237 both shipped a **D-056**. `MEMORY/archive/2026-07-16.md` shows the collision being caught
  by hand during a rebase and one entry renumbered D-056 → D-057 across "14 code refs" — but the
  rename never landed in the log itself, and D-057 was later claimed by PD-377. The log had two
  D-056 headings until PD-490 found them by counting. A hand-check that is performed, recorded as
  done, and still leaves the defect in place is the argument for a mechanical one. (CLAUDE.md's
  "check the highest `D-NNN` on `origin/main` immediately before committing" is that hand-check;
  it stays useful as a way to *avoid* the collision, but it is no longer what *detects* it.)
- **Reversing the order — append at the bottom, read bottom-up — buys nothing.** Git conflicts are
  hunk-level: two appends at end-of-file add lines at the same offset with the same preceding
  context and conflict exactly as two prepends do. Prepend and append are symmetric for this. It
  would have cost a convention change and every reader's habit for no reduction in conflicts.
- **The numbers earn their keep, so they stay.** `D-NNN` has ~1,000 citations across ~106 files —
  PROJECT.md's glossary, code comments, test names, ticket bodies, MEMORY, and the log's own
  `[[D-046]]` links. Replacing the scheme means either a migration that touches all of them or
  living with two schemes forever. The conflict cost lives in the *layout*; nothing about it is
  fixed by changing the identifier.
- **The index carries id, title and link — and deliberately no date or separate summary.** Every
  field in a generated index is a field that can drift from the file it describes. These titles are
  already written as full sentences, so the title *is* the one-line summary; a second summary field
  would be a second thing to keep true. Ordering is chronological because the numbering is, and
  `git log --diff-filter=A` has the real dates when anyone needs them.
- **Generated, and a stale index fails the build.** A rollup that has to be hand-maintained
  alongside the files is the same duplication problem one level up. The test regenerates the index
  and compares, so "I added a decision and forgot the index" is a red check with the fix in the
  error message, not a slow divergence.
- **The parser is shared with the agent-worker on purpose.** The worker will inject this index into
  agent context, so the file humans read and the block agents read come out of one implementation
  and cannot disagree.

**Implications:** `DECISIONS.md` is now generated — editing it by hand is a lost edit. Writers were
updated to create a file: the Robot's system prompt (`prompt.ts`), `CLAUDE.md`, `.claude/commands/wrap-up.md`,
and the loop re-enablement handoff.

**Revisit if:** the Karpathy/graph memory epic (PD-350) lands. The two are the same shape — a graph
solves this **only** if its granularity is node-per-decision, which is file-per-decision by another
name — so this migrates into it rather than being thrown away. If that graph were one large
document, it would inherit this exact problem.
