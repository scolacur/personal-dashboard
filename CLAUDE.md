You are an agent helping me build this project.

At the start of EVERY session, do the following:

- Read PROJECT.md

Let me know when you've completed reading it.

---

# RULE 1 — Work in a git worktree. Never in the main checkout.

**Do this before you edit a single file.** Not before you commit — before you edit.

```bash
git fetch origin
git worktree add .claude/worktrees/<ticket-slug> -b <branch-name> origin/main
cd .claude/worktrees/<ticket-slug>
npm ci          # a worktree is a separate directory; it needs its own node_modules
```

Everything after that — edits, `npm run verify`, commit, push, `gh pr create` — happens in
**that directory**. When the PR merges: `git worktree remove .claude/worktrees/<ticket-slug>`.

## Why this is not optional

**Several agent sessions run against this one checkout at the same time.** They are not
coordinated and cannot see each other. Another session will `git checkout`, `git pull`, or
`git rebase` the main tree *while you are mid-task*, and nothing warns you. Everything below has
actually happened here, more than once:

- **Your commits land on the wrong branch, or on `main`.** Another session checked out its own
  branch between your edits and your `git commit`. On 2026-08-06 a PD-475 commit landed directly
  on local `main` and a memory commit landed on an unrelated session's PD-424 branch.
- **`npm run verify` silently tests someone else's code.** Same day: a full verify ran green
  against another session's branch after they took the tree mid-run — a meaningless result that
  looked exactly like a real one. In the other direction, a session's verify failed on *your*
  half-written file and cost them a debugging detour.
- **`git pull` refuses** while another session has uncommitted work in the tree.
- **Their uncommitted work sits in your `git status` all session.**

A worktree makes every one of these impossible. It is one command.

## The rules that still apply inside a worktree

- **Stage by explicit path. Never `git add -A` or `git add .`.** If you are in the main tree for
  any reason, that command commits another session's in-progress work — including their `MEMORY/`
  edits — into your branch.
- **Never check out, rebase, reset, or delete a branch another session is using.** If you find
  your commit on someone else's branch, cherry-pick it onto yours and leave theirs alone.
- **Once your PR merges, the branch is dead — stop committing to it.** Steve merges fast (69
  seconds after the last push, in one measured case). A commit you push to a branch whose PR has
  already merged goes nowhere: GitHub does not add commits to a closed PR. Before pushing more
  work to a branch you already opened a PR for, check the PR is still open; if it merged, branch
  fresh from `origin/main`.
  **This is not a squash defect.** Earlier notes here blamed "a squash merge dropping commits";
  that was a misdiagnosis, verified false by timestamps on 2026-08-12 (the "dropped" commit was
  authored four days *after* its PR merged). Squash takes everything on the branch at merge time.
  The habit is still worth keeping — after a merge, verify what you care about actually reached
  `main` with `git show origin/main:<path>` — but for this reason, not that one.
- **Never allocate a `D-NNN`** — the old "check the highest one on `origin/main` first" habit is
  obsolete, because you no longer pick a number at all (D-078). See the decisions section below.

---

**Backlog:** TODOs are no longer tracked in `TODO.md` files — they live as **tickets in the
Task Monitor** (`/task-monitor`), backed by the `agent_tickets` table.
The board is the single source of truth for project tasks across all projects. Query them via the
API — `GET /api/widgets/task-monitor/tickets` on the NAS (`http://192.168.68.50:8088`), which is
the only source of real data; local `:8080` serves dummy dev data. There is no by-id route: fetch
the array and filter on `displayId`. (The older `/api/widgets/agent-dashboard/…` base is **stale
and 404s** — it was renamed.) The old `TODO.md`/`META-TODOS.md` files were seeded into the board
and archived to `/Users/steve/Documents/Dev/archive/` (see D-020).

**A merged PR does not complete its ticket.** The Robot loop only completes tickets *it*
dispatched, so anything built by hand must be `PATCH`ed to `completed` yourself.

**Decisions (D-070, D-078).** Each decision is its own file; `DECISIONS.md` is a **generated** index
over them and must never be hand-edited — that edit is lost on the next regeneration.

- If you are ever uncertain about why we are taking a certain design approach, skim the index in
  `DECISIONS.md` and open the file that looks relevant. Entries listed under **Awaiting a number**
  are just as settled and binding as the numbered ones — only their id is provisional.
- Whenever we make a significant architectural decision, **write it into the decision inbox** as
  `DECISIONS/incoming/D-TMP-<TICKET><letter>.md` — e.g. `DECISIONS/incoming/D-TMP-PD513a.md`, first
  line `# D-TMP-PD513a: Title`. Use `b`, `c`, … if one ticket produces more than one. Cite it by
  that provisional id everywhere. Then run `npm run decisions:index`.
- **Never write `DECISIONS/D-NNN-slug.md` by hand, and never pick a number** — not even in a solo
  session where you are sure nothing else is running. That check is exactly the hand-check this
  replaces, and it has been wrong here twice (D-056, D-065). A daily numbering cycle assigns the
  `D-NNN` in merge order and rewrites every `D-TMP-` citation for you.
- Writing a file rather than appending to the index is what lets parallel sessions each log a
  decision without touching the same lines; leaving the number to the cycle is what stops them
  claiming the same one.
