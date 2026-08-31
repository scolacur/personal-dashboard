# D-088: Decision ids are allocated at authoring time by a counter in the DB; the decision itself stays in git (PD-556; supersedes D-078)

**Decision:** An author asks for a number *before* writing, and writes the real file straight away.

- **`POST /api/decisions/allocate`** returns the next `D-NNN`. The server increments a single-row
  counter in `dashboard.db` inside one atomic statement. That counter is the **only** allocator.
- The author writes `DECISIONS/D-NNN-<slug>.md` with `# D-NNN: Title` as its first line, and cites
  `D-NNN` in code immediately and permanently.
- Robots reach the same counter through **`mcp__decisions__allocate`**, an in-process tool the
  worker runs on their behalf. They still cannot touch the database ([[D-087]]).
- **Content stays in git.** Only allocation moved.
- Provisional ids, `DECISIONS/incoming/`, the numbering cycle, the repo-wide citation rewrite, and
  the `EG` example namespace are all deleted. [[D-078]] is superseded.

**Why:**

- **Every problem the decision system had descended from one choice: ids were assigned late.**
  Provisional ids existed because an author could not safely pick a number. The numbering cycle
  existed to convert them. The repo-wide citation rewrite existed because that cycle had to fix
  ~150 references. And that rewrite is what corrupted its own test fixtures on 2026-08-23 — it
  rewrote a provisional id inside the string literals of the tests that verify rewriting, correctly
  by its own rules, which is the point (closed PR #361). It also reddened path-guard on every run,
  and made the dangling-citation check report 100% false positives. **If the id is right the moment
  it is written, none of that exists.** There is no rename, so there is nothing to prove to
  path-guard, nothing to corrupt, and no ambiguity about whether an id in a source file is a
  citation or an example.
- **Only allocation needs a database; content emphatically does not.** A decision arrives in the PR
  diff next to the code that motivated it, which is most of why the decisions here are any good.
  `git grep D-078` works offline, from any checkout, at any commit. Git is distributed, versioned
  and backed up. Moving bodies into a table buys none of that back, and would make PD-550's backup
  job load-bearing for the project's entire reasoning record.
- **"Fetch an id" cannot be a pure read.** Two authors who both read *next = 86* both get 86 — the
  exact collision being removed. Allocation has to be atomic, so the server performs it and the
  author asks. This is why the endpoint is a `POST`, and why both the server and the worker use one
  `UPDATE … RETURNING` rather than a read followed by a write.
- **Allocation is per decision, at the moment of writing** — not one id per dispatched run. A run
  may record several decisions; a fixed pre-allocation either wastes an id on every run that decides
  nothing or runs out mid-run on the one that decides three things.
- **Gaps are harmless and there is no reclaim path.** An id taken for an abandoned PR is simply
  never used. `D-086` is an identifier, not a count. Reuse is how you get two decisions wearing one
  number, which is the failure [[D-056]] and [[D-065]] already produced by hand — twice.

**Trade-off:** The number is no longer derivable from the repo alone: authoring now depends on a
reachable service, where before it depended only on a text editor. Accepted, because the dependency
is small and local (a LAN endpoint, or an in-process tool for Robots), and because the alternative
was a nightly job that rewrote the entire repository to fix up what the editor could not know. A
service being briefly unavailable costs one parked decision; the rewrite cost a corrupted test suite
and a red CI check on every run.

**A second trade-off, reintroduced knowingly:** authoring again touches a shared file. PD-551 kept
provisional decisions out of `DECISIONS.md` precisely so that two concurrent authors could never
collide on the index; with nothing provisional left, every author now regenerates it and commits the
result. Two authors on the same day will get a git **conflict** on `DECISIONS.md`. That is materially
better than what PD-551 was avoiding — a conflict is loud, and the resolution is mechanical (`npm run
decisions:index` after the merge, because the file is generated), where the old failure was two
decisions merging silently under one number. Accepted on those terms. If it bites often, the fix is
to stop committing the generated index, not to bring provisional ids back.

**Implications:**

- [[D-078]] is superseded in full. [[D-070]] (one decision per file, `DECISIONS.md` generated) is
  unchanged — only the id's provenance changed.
- The maintenance hold **stays** ([[D-081]], [[D-082]], [[D-085]]) and simply loses its only
  subscriber. It is the general machinery for touching shared files with no Robot working, and
  rebuilding draining, window-bounding and safe release later would be the expensive part. Its flag
  is renamed `MAINTENANCE_HOLD_ENABLED`, and with no jobs registered it opens no *scheduled* holds —
  manual ones still work.
- **Slice order was inverted during the epic, and the reason is worth keeping.** The cutover had to
  land *before* the instructions were flipped: while the numbering cycle and the counter were both
  live they were two allocators racing for the same number, and telling authors to use the counter
  first would have created the precise collision this decision removes.
- PD-547 is closed out entirely — there is no rename left to prove to path-guard. PD-548's reserved
  example namespace is deleted with the rewriter that made it necessary. PD-537 is moot: the cycle
  it wanted to prove no longer exists.
