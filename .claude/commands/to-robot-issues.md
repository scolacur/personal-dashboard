# /to-robot-issues

Turn a board ticket (or a plain description / PRD) into one or more **Robot-ready GitHub issues**,
sized as atomic vertical slices, drafted in the format the Robot loop's coding sessions consume,
shown for approval, then created and routed into the Robot's Queue (`robot_queue`).

Takes an argument: a board ticket id (e.g. `PD-160`), a GitHub-flavored description, or a path/paste
of a small spec. If none is given, ask what to convert.

## Background — how the Robot loop consumes an issue (why the format is what it is)

The Robot loop injects the ticket into the coding session's prompt as **just** the title + body
verbatim — there is **no structured field parsing**. So no schema is *required*, but the prompt
imposes behaviors that specific sections feed directly:

- It enforces **scope discipline** ("stay within the scope of this one issue; do not refactor
  unrelated code") → an explicit **Out of scope / guardrails** section maps onto this and curbs bad
  assumptions.
- It runs a **`npm run verify` self-gate** → a concrete **Done When** checklist gives the agent a
  target and makes its PR acceptance-echo meaningful.
- Exact **file paths** in Context keep it from hunting (saves tokens + wrong-file risk).

Do **NOT** put a "Return"/PR-envelope section in the issue — the Robot prompt already mandates
the PR output envelope (Closes # / Status / Summary / Acceptance / Files changed / **Testing** /
Assumptions). That envelope requires the agent to include **testing instructions** (how a human
verifies the change) in *every* PR, so you never need to ask for it per-issue — an issue-level
envelope just duplicates and competes with the prompt.

## The format (per issue)

```markdown
## Context
What this is, where it lives (name the actual files/functions), and the current state — including
anything already present that the agent must not re-build or would otherwise trip over.

## Task
The change to make, as concrete bullets. Reference existing patterns to mirror.

## Done When (acceptance checklist)
1. [ ] Specific, testable outcomes — API round-trips, UI states, no-regressions, and
       `npm run verify` passing (exit 0).

## Out of scope / guardrails (do NOT touch)
- Explicit exclusions: what belongs to sibling issues, and the standing guardrails
  (no `.env*`/CI/auth/schema/dep changes unless the task IS that).
```

## Instructions

### Step 1 — Resolve the input

- If given a board ticket id (`PD-\d+`, `C-\d+`, `NSW-\d+`): fetch it from the Task Monitor API
  and read its title + body:
  ```sh
  BOARD="${ROBOT_BOARD_URL:-http://192.168.68.50:8088}"   # prod on the LAN; dev = http://localhost:8080
  curl -s "$BOARD/api/widgets/task-monitor/tickets" \
    | python3 -c "import json,sys; t=[x for x in json.load(sys.stdin) if x['displayId']=='PD-160']; print(json.dumps(t[0],indent=2) if t else 'NOT FOUND')"
  ```
- If given a description/spec: use it directly.
- Otherwise: ask what to convert.

### Step 2 — Ground the draft in the real code

Before drafting, inspect the codebase so Context names real files and the acceptance criteria are
achievable. Check whether the thing already partly exists (columns, types, helpers, sibling
patterns) — the biggest quality win is telling the agent what NOT to rebuild and which existing
pattern to mirror. Prefer an `Explore` subagent for wide reads.

### Step 3 — Decide atomicity (split if needed)

The Robot loop wants **small PRs**. Split the work into independent **vertical slices** — each one
shippable, testable, and reviewable on its own. Split when a ticket spans multiple layers/deliverables
(e.g. backend wiring + a data-entry UI + a display UI + an interaction rule). Prefer 2–3 focused
issues over one sprawling one. When you split, make dependencies explicit (see Step 6).

### Step 3b — If the task is large, vague, or high-risk, grill it first

If, while grounding and slicing, the task looks **complex or underspecified** — many unknowns,
cross-cutting design decisions, unclear acceptance criteria, or you find yourself guessing at
requirements — **suggest the user run `/grill-me` first** (or **`/grill-with-docs`** if it should be
reconciled against the domain model / `CONTEXT.md` / ADRs). A grilling session resolves the open
decisions so the resulting issues encode real answers instead of your guesses — which is what keeps
them atomic and unambiguous for an unattended agent. Offer it; don't force it. If the task is already
clear (or the user declines), proceed to draft.

### Step 4 — Draft each issue in the format above

One title per issue (descriptive; the board `[Domain]` prefix is fine). Fill Context with real file
paths, Task with concrete bullets, Done When with testable checks (always include `npm run verify`),
Out of scope with the exclusions + standing guardrails. **No Return section.**

### Step 5 — Show the drafts for approval — STOP

Print every drafted issue in full and the atomicity decision (how many, and why). **Do not create
anything yet.** Wait for explicit approval. Offer: create as-is / tweak / keep as one issue.

### Step 6 — On approval, create + queue

- Create each issue: `gh issue create --repo scolacur/personal-dashboard --title "…" --body-file …`.
- **Queue ONLY the issues with no unmet dependency** — route them into the Robot's Queue
  (`robot_queue`) on the board so the Robot loop dispatches them. For a dependent issue, leave it
  **un-queued** (out of `robot_queue`) with `Depends on #<N>` in its Context, and tell the user to
  queue it after the dependency's PR merges. Queuing a dependent wastes a Robot run on work it can't
  complete (it lacks the predecessor's API) and burns against the loop's per-ticket fault budget.
- A queued ticket is picked up on the loop's next poll and flips to `working` — expect that, it
  means dispatch worked.

### Step 7 — Report

List the created issue numbers, which were queued vs held, and the queue-after-merge order. If the
input was a board ticket, note that the board links only one `githubIssueNumber` per ticket (the
one-ticket→many-issues case is a known limitation — pick the primary or leave unset).
