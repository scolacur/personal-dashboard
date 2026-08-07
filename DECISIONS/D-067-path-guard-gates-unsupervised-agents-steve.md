# D-067: The path-guard gates unsupervised agents, not Steve — author-scoped, with a Robot-branch backstop (PD-474; amends D-047)

**Decision:** the Tier 1 **path-guard** requires the `sensitive-change-approved` ack from every PR
author *except* an allowlist in the workflow (`AUTHORS_EXEMPT`, currently just `scolacur`), and
never skips the ack on a `robot/*` / `sortie/*` head branch regardless of author. An exempt PR still
prints the sensitive paths it touched to the job summary — green, but never silent. The denylist
(`.github/sensitive-paths.txt`) is **unchanged**: this scopes *who* is gated, not *what* is
sensitive. Chosen over the four alternatives brainstormed in PD-474 (narrow the glob / content-aware
DDL guard / shared DB access layer / cheaper ack).

**Reasoning:**

- **The guard's teeth were always aimed at an unsupervised agent.** D-047 drew it against a Robot
  that may edit any file with only a prompt telling it not to; the ack is collaborator-gated
  precisely as a *trust boundary*. A human collaborator with merge rights is on the trusted side of
  that boundary already — the ack was asking him to grant himself permission he holds.
- **The false positives were structural, not incidental.** Every widget owns a `schema.ts` by
  convention (PROJECT.md §2), so `**/schema.ts` fires on every PR of any epic that is building a new
  widget — BST (PD-437/438/439/440) made the whole remaining epic a permanent red-check magnet.
  That is a recurring cost with no matching risk: a week-old table nobody depends on is not the
  `agent_tickets` case the guard exists for.
- **A control that cries wolf gets bypassed, and this one is bypassable by design.**
  `enforce_admins` is `false`, so `--admin` walks straight past a red guard — and already has:
  PD-308's own docs PR (#283) merged with no label, meaning the label→green path has still only ever
  run on a throwaway. Every false positive trains the exact reflex that caused #268. Removing the
  noise is what keeps the check meaningful where it still fires.
- **It fails closed.** `GATED=yes` is the default, the author allowlist is the only thing that
  clears it, and the branch check can only ever *add* gating. The author comes from the
  `pull_request_target` payload, which GitHub populates from the base branch — a PR cannot declare
  its own author, and cannot weaken the allowlist in the same change (`.github/**` is itself
  sensitive, and the guard runs base-ref).
- **The branch backstop covers the one way author-scoping could silently die.** Today the Robot
  pushes as `sortie-bot-55` with its own write PAT, so author-scoping alone would hold (verified:
  70 of 200 PRs are the bot's, all on `robot/*` or `sortie/*`). If that identity ever collapses onto
  Steve's token, author-matching would exempt every Robot PR and the guard would cover nothing while
  still reporting green. The prefix check makes that failure mode loud instead of invisible.
- **Exemption is a green exit, not a skipped job.** `path-guard` is a *required* status check; a job
  skipped by a job-level `if:` reports a `skipped` conclusion rather than the success branch
  protection expects. The job always runs and always reports — the same care D-047's wiring took
  when it proved the check in both directions before making it required.
- **What we accept:** "protect Steve from himself" is gone. That was never the stated purpose, it is
  partially recovered by listing the paths in the summary, and Steve reviewing his own diff is the
  same act the ack label was asking him to perform.
- **Why not the alternatives (all still open in PD-474):** narrowing `**/schema.ts` needs a
  remembered chore every time a widget's tables start holding real data; a content-aware DDL check
  puts fallible logic inside the guard and is inexpressible in Tier 2, which can only state path
  globs; the shared DB access layer is worth doing for its own reasons but renames the risky file
  rather than removing the risk. Author-scoping is the only one that targets the actual complaint
  (Steve's feature work) without touching what the denylist claims is dangerous.

**Implications:** **Amends D-047** (Tier 1 is now scoped by author; the two-tier structure, the
shared denylist, and base-ref evaluation are untouched). **Tier 2 (PD-312) is deliberately not
scoped this way** — Claude Code deny rules have no author concept, and the Robot is exactly the
population that stays gated, so they stay unconditional. PD-474 stays open as the brainstorm for the
*denylist-shaped* problem (a Robot building a new widget still trips `**/schema.ts` on every PR);
this decision removes the noise for Steve, not for agents. PROJECT.md §9 glossary (**Path-guard**,
**`sensitive-change-approved`**, the Tier 1 status banner) and
`docs/handoff-loop-reenablement.md` updated inline. If a second human ever gets write access, they
go in `AUTHORS_EXEMPT` — a one-line workflow change that itself trips the guard.
