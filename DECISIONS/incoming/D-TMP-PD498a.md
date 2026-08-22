# D-TMP-PD498a: The maintenance hold gets its own slot, and the numbering cycle reports dangling citations rather than repairing them (PD-498; implements D-078)

**Decision:** three calls made while building D-078's numbering cycle, none of which D-078 settled:

1. The **maintenance hold is its own `robot_state` key**, not a third `kind` on the session-limit
   hold. `kind` survives, for display only.
2. A numbered decision's **slug is derived from its title** by the cycle, not supplied by the author.
3. A `D-TMP-` citation with no decision behind it is **reported and left alone**, never rewritten —
   and this is the answer to the open-PR question D-078 explicitly deferred.

**Reasoning:**

- **D-078 said "a third kind on the existing hold, not new machinery", and that is wrong on the
  code.** `session_limit_until` is a single k/v slot with last-writer-wins semantics, so sharing it
  fails silently in both directions. A provider session limit arriving mid-cycle overwrites the
  maintenance hold's `until` and `reason`; when the quota window expires, dispatch resumes while the
  cycle is still rewriting files. In reverse — worse — the cycle finishes, releases "the hold", and
  nulls a session-limit hold that arrived while it ran, resuming dispatch into a spent quota. That
  is precisely the failure [[D-063]]/PD-470 exists to prevent, reintroduced by tidiness.
  Two conditions with independent causes and independent lifetimes need two slots, so that a release
  only ever clears what its owner set. Same rule [[D-077]] applied to memory files: one owner per
  slot. `kind` still distinguishes them for the dashboard; it is just not what keeps them apart.
- **The hold lapses as well as being released.** `until` is a deadline, not a schedule: the cycle
  releases explicitly in a `finally`, and the lapse exists only so a cycle killed between taking the
  hold and releasing it cannot wedge dispatch shut until a human notices. Bounded by
  `stallThresholdMs`, the same bound a stalled run gets.
- **The slug is derived because the identity does not depend on it.** `Decision.slug` is documented
  as cosmetic and deliberately not part of the identity, which is exactly what makes generating it
  safe — nothing breaks if a human would have chosen better words. The alternative, asking the
  author for a slug alongside the provisional id, adds a second thing to get right at authoring
  time, and reducing that count is what D-078 was for. Truncated at 60 characters on a word
  boundary, because titles here run long and carry parentheticals.
- **A dangling citation is evidence, not a defect to paper over.** It means a citation points at a
  decision that is not in the inbox — a typo, a decision file deleted without its citations, or the
  case D-078 flagged and left open: a PR that was open across a previous cycle, still citing a
  `D-TMP-` id that has since become a `D-NNN`. Rewriting it to something plausible would bury the
  cause; the cycle notifies and moves on, and the citation stays visibly wrong until a human looks.
- **That open-PR case needs no hold-side handling at all**, which is the part worth recording,
  because D-078's grilling notes assumed it did ("the job would renumber around it and then collide
  on merge"). It cannot collide: a provisional file carries no number, so a PR merging one after a
  cycle simply leaves it in the inbox for the next cycle. The only residue is a stale citation in
  that PR's own prose, which is the dangling case above. A ledger mapping retired `D-TMP-` ids to
  their numbers was considered and rejected as disproportionate: the mapping is already in git
  history, the residue is rare at a daily cadence, and a self-describing marker in the numbered file
  would itself be rewritten by the next citation sweep.
- **The cycle skips rather than forces when the drain times out.** Rewriting under a live run edits
  files a Robot has open, and the resulting conflict lands on *that Robot's* PR, where it is someone
  else's confusing problem. Skipping costs a day of provisional ids, which is exactly the cost the
  index rendering was built to make survivable.
- **No LLM anywhere in the job.** A rename and a regenerated index need no judgement, and an agent
  here would add token cost plus a non-deterministic failure mode attached to the decision record.
  It lives in `jobs/` for the shared host — checkout, proxy, DB, hold — not because it is an agent.

**Implications:** `DECISION_CONSOLIDATION_JOB_ENABLED` ships **off**, like `ROBOT_DISPATCH_ENABLED` and
`EVALUATOR_ENABLED` — a job that rewrites citations repo-wide and admin-merges its own PR should not
start doing so merely by arriving in an image. The rewrite sweep must skip `.claude/worktrees`,
because this repo nests worktrees inside the checkout and every concurrent session's branch lives
there.

**Revisit if:** dangling citations stop being rare, which would mean PRs routinely sit open across
cycles and the ledger rejected above becomes worth its cost. Or if the drain routinely times out —
that is the throughput cost D-078 said to watch for, and the recorded fallback is its optimistic
scheme, not a new idea.
