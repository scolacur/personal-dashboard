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
- **A squash merge is not a promise your commits are included.** Memory and docs committed on a
  feature branch have been dropped by a squash here before. After a merge, verify what you care
  about actually reached `main`: `git show origin/main:<path>`.
- **Check the highest `D-NNN` on `origin/main`, not on your branch, immediately before
  committing a decision.** Parallel sessions reserve the same number.

---

**Backlog:** TODOs are no longer tracked in `TODO.md` files — they live as **tickets in the
Task Monitor** (`/task-monitor`), backed by the `agent_tickets` table.
The board is the single source of truth for project tasks across all projects. Query them via the
API — `GET /api/widgets/task-monitor/tickets` on the NAS (`http://192.168.68.50:8088`), which is
the only source of real data; local `:8080` serves dummy dev data. There is no by-id route: fetch
the array and filter on `displayId`. (The older `/api/widgets/agent-dashboard/…` base is **stale
and 404s** — it was renamed.) The old `TODO.md`/`META-TODOS.md` files were seeded into the board
and archived to `/Users/steve/Documents/Dev/archive/` (see DECISIONS.md D-020).

**A merged PR does not complete its ticket.** The Robot loop only completes tickets *it*
dispatched, so anything built by hand must be `PATCH`ed to `completed` yourself.

If you are ever uncertain about why we are taking a certain design approach, read `DECISIONS.md` to see if the reasoning is there.

Whenever we make a significant architectural decision, add it to `DECISIONS.md`.
