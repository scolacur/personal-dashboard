# D-078: Decisions are authored with a provisional id and numbered in a daily cycle behind a maintenance hold (PD-498)

**Decision:** every decision is authored in the **decision inbox**, `DECISIONS/incoming/`, under a
**provisional id** of the form `D-TMP-<ticket><letter>` (e.g. `D-TMP-PD513a`), and cites itself by
that id everywhere. A daily **numbering cycle** — a deterministic `agent-worker` job — takes a
**maintenance hold** on dispatch, waits for in-flight runs to drain, assigns each merged provisional
decision its `D-NNN` in merge order, rewrites every `D-TMP-` citation, regenerates `DECISIONS.md`,
opens a PR, waits for CI, admin-merges it, and releases the hold. Nobody ever writes
`DECISIONS/D-NNN-slug.md` by hand — including a solo human session. `renderDecisionsIndex` lists
provisional decisions above the numbered ones so they are visible to injected agents immediately.

**Reasoning:**

- **[[D-070]] eliminated the text conflict and left the allocation collision, deliberately.** It
  chose to let an author claim the next free number and to *catch* a double-claim with a CI test over
  the merged tree. That is detection, not prevention, and it has a known gap: branch protection is
  `strict: false` on purpose (`ci.yml` records that forcing every PR up to date would wedge the Robot
  loop), so two PRs can each go green against merge bases that exclude the other and both land. `main`
  goes red within minutes on the `push: [main]` run — after the merge, not at the gate. At
  `ROBOT_CONCURRENCY=1` the only collision window is one Robot against a human session; raising the
  cap opens it fully, which is why this gates PD-512.
- **The alternative — claim optimistically, automate the repair — was considered and rejected.**
  It preserves citation-at-authoring, which is not nothing: every one of the last six decisions is
  cited *outside* `DECISIONS/` in the very commit that creates it (D-072: 2 lines, D-073: 35,
  D-074: 5, D-075: 10, D-076: 23, D-077: 4). But it leaves collisions possible by design and pays
  for them with a repair PR that rewrites citations *after* they have been read, and it keeps
  `main` going red as a routine event. Prevention was preferred to a faster, noisier recovery.
- **Loop-side allocation at dispatch was rejected separately.** The Robot is DB-blind ([[D-039]]), so
  a number would have to be reserved and injected before the run starts — which covers robot-vs-robot
  only, burns a number on every run that writes no decision (most of them), and allocates exactly one
  where a run may need two. Every collision that has actually happened was human-vs-human: D-056
  across PRs #235/#237, undetected for three weeks, and D-065 on 2026-08-05.
- **The provisional id is namespaced so the rewrite is mechanical.** `D-TMP-` can never match
  `D-\d{3}`, so a blind `grep -rl` is safe. Citing the bare ticket id instead (`PD-513`) was rejected:
  the repo is full of *genuine* ticket citations, often in the same paragraph as the decision's, and
  no rewrite can tell "the decision" from "the ticket". The trailing letter covers one ticket
  producing two decisions.
- **The inbox costs no parser change.** `loadDecisions` skips any entry that does not end in `.md`,
  so a `DECISIONS/incoming/` directory is invisible to it. A provisional file placed directly in
  `DECISIONS/` would instead throw and break `npm run decisions:index` for everyone, since the id is
  asserted twice — in the filename *and* in the first-line heading, which must agree.
- **The authoring PR stops touching the generated index entirely**, because a provisional file is not
  indexed. That removes the one conflict `DECISIONS.md` still had (two branches each inserting a line
  at the top) as a side effect, and largely retires PD-515.
- **The hold is forced rather than waited for.** "Run when no agents are dispatched" is unbounded
  exactly when the system is busiest — the fuller the queue, the longer decisions stay provisional.
  Taking a hold and draining bounds the wait instead, at ~2h worst case (`stallThresholdMs`, so a
  hung run is parked rather than blocking forever). It is a **hold**, not a **pause**, in the sense
  [[D-063]]/[[D-072]] fixed: tickets stay queued, budget untouched, resumes unattended. A pause is
  sticky and needs a human, which is wrong for a daily maintenance window.
- **Provisional decisions are indexed, which is what makes a ~24h cycle acceptable.** The index is
  injected into every agent's orientation ([[D-071]]) precisely so settled decisions are not
  re-litigated; a decision that is on `main` but invisible for a day defeats that. Listing it under
  its provisional id costs ~10 lines in `renderDecisionsIndex` and means the code's citations and the
  index agree at every moment.
- **"Provisional" attaches to the identifier, not the authority.** A decision is settled and binding
  the moment it merges. "Draft" and "pending" both imply otherwise, and an agent reading an index
  section headed *Pending* may reasonably treat those entries as proposals it can argue with.
- **One authoring path, including for a solo session.** A dual path — hand-number when you know you
  are alone — reintroduces the collision it removes and makes the CI test load-bearing again. "Am I
  the only session right now?" is exactly the hand-check D-070 argued against, and in practice
  several sessions run at once here.
- **The job admin-merges after CI, and never past it.** A daily PR whose diff is mechanical renames
  is the definition of a rubber-stamp review, on the one bot PR that touches source files repo-wide;
  requiring an approval every day would decay into approving unread. `--admin` bypasses the
  approval requirement (and path-guard's label ask, since a citation rename is not a semantic change
  to a sensitive file) — it never bypasses a red `verify`. On red, the job leaves the PR open,
  notifies, and releases the hold.

**Implications:** `CLAUDE.md`, the Robot's prompt (`packages/shared/src/agent-prompts.ts`), and
`/wrap-up` all instruct writing `DECISIONS/D-NNN-slug.md` and running `npm run decisions:index`;
all three change to the inbox + provisional id, and the "check the highest `D-NNN` on `origin/main`
before committing" habit becomes obsolete. The CI duplicate-id test stays as belt-and-braces rather
than the only line of defence. `nextDecisionId`'s doc comment says "the lowest `D-NNN` no file has
claimed" while the implementation returns highest + 1; the cycle assigns from the highest, so the
comment is what is wrong.

**Revisit if:** the drain routinely costs more throughput than the collisions would have — in which
case the optimistic scheme above is the recorded alternative, not a new idea. Or if provisional ids
leak into long-lived prose that the rewrite misses, which would mean the `D-TMP-` grep is not
catching every citation site and the namespace needs tightening rather than the scheme replacing.
