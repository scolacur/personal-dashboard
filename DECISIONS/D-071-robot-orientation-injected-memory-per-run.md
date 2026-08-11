# D-071: The Robot's orientation is injected, not fetched — and its memory is one file per run (PD-306)

**Decision:** a dispatched Robot receives `PROJECT.md` (in full), the generated `DECISIONS.md`
index, and the last two `MEMORY/YYYY-MM-DD.md` day files as an **injected block appended to its
system prompt**. It runs no orientation command. `CLAUDE.md` is deliberately excluded and the Robot
is told to ignore it. At the end of a run it writes **one memory file per run** —
`MEMORY/runs/YYYY-MM-DD-<branch>.md` — committed on its branch and merged with its PR; `/wrap-up`
folds those into the day file and deletes them. No new slash commands.

**Reasoning:**

- **A command is a leash the agent has to put on itself.** The ticket originally asked for Robots
  to *run* `/harness [project]` and `/wrap-up`, with `/harness-for-robot` variants proposed as a
  follow-up. An autonomous agent instructed to orient itself may simply not, and the failure is
  silent: the run proceeds under-informed while still burning turns, and nothing distinguishes it
  from a run that oriented properly. Injection cannot be skipped. The *content* of those commands
  survives; the commands themselves have nothing left to do.
- **Most of `/harness` is actively wrong for a Robot, not merely redundant.** It resolves which
  project to load (a Robot is dispatched at exactly one), runs a memory-aging pass that `git mv`s
  day files (a Robot has no business reorganising memory), and prints an orient block for a human
  to read (nobody is there). Only the *reading* half transfers.
- **`CLAUDE.md` is excluded because it contradicts the architecture, not because it is noise.**
  RULE 1 tells the reader to create a git worktree — a Robot is already in a dedicated one.
  "Never `git add -A`" contradicts the Finish sequence, which uses it deliberately because a
  Robot's worktree is exclusive to that run. And the backlog section instructs the reader to query
  the board API and `PATCH` tickets to `completed` — a Robot is **DB-blind by design** (D-039) and
  the loop owns that transition. Handing an unsupervised agent those lines invites exactly the
  behaviour the architecture forbids, so the task prompt now names all three contradictions and
  tells it to ignore the file.
- **The DECISIONS *index*, not the decisions.** Post-[[D-070]] the index is ~80 lines of id + title
  + link: short, complete, and enough to point at the two files that bear on a given ticket. The
  bodies stay on-demand via `Read`. Injecting all ~70 would be thousands of lines with a terrible
  relevant-to-irrelevant ratio, and the existing "read it when a choice is non-obvious" instruction
  already works.
- **PROJECT.md goes in whole, on purpose.** ~620 lines. Guessing which half matters per ticket is
  how an agent ends up contradicting a settled convention. The eventual token audit decides what to
  pare with measurements; this decision declines to guess.
- **Orientation rides the SYSTEM prompt, not the task prompt.** It is identical for every ticket in
  a repo, so it belongs in the stable, prompt-cacheable prefix rather than being re-sent as fresh
  tokens with each ticket.
- **Memory is one file per run because the day file is the conflict shape we just removed.**
  `MEMORY/YYYY-MM-DD.md` is a single file that concurrent Robots — *and* human sessions — would all
  append to. That is precisely what [[D-070]] eliminated for decisions, and it is worse here
  because a human edits the day file too. One file per run means every writer touches a different
  path and git merges them without anyone resolving a conflict, least of all an unsupervised agent.
  This reverses `.claude/commands/wrap-up.md`'s previous "Robot runs never write to MEMORY/" rule,
  which was the right conclusion from the wrong premise: the problem was never *writing to
  MEMORY/*, it was writing to a **shared file**.
- **Memory rides the branch, not a direct push to `main`.** A Robot must never push to `main` — the
  PR gate is the safety model. The convention of committing memory straight to `main` is a human
  workaround for a squash-merge race, not a property of memory.
- **`MEMORY/runs/` is an inbox with an owner.** Files accumulate until `/wrap-up` curates them into
  the day file and deletes them. Left unowned it would become a second, uncurated memory system;
  naming the curation step and the deletion is what keeps it a queue.
- **A missing orientation source warns rather than fails.** A Robot with a smaller pack is degraded,
  not broken, so the run proceeds — but PD-496 (two months of Refine silently receiving no glossary)
  is the standing argument that it must never be silent about it.

- **Every agent prompt moved to `packages/shared`, because the Agent Glossary renders them.** The
  dashboard's glossary modal shows what each agent is responsible for *and the prompts it actually
  receives* — produced by calling the same builders the worker calls, with placeholder inputs. A
  transcribed prompt in the UI would be wrong within a week, and wrong in the least detectable way:
  nothing fails when documentation drifts from behaviour. So there is one source and no sync step.
  The builders are pure string-building (no `node:*`, no config), which is what lets the browser
  import them; `buildOrientation` keeps the filesystem reads in the worker and calls the shared
  `orientationBlock` / `composeOrientation` so even the *structure* has a single definition. The
  tests assert each rendered section equals its builder's output, so pasting text into the UI fails
  CI. (PD-500 tracks making them editable *from* the modal, which needs versioning, attribution, and
  a hard line around the structural steps below.)

**Implications:** the Finish sequence gained a documentation sub-step before the commit — ordering is
load-bearing and pinned by a test, since a memory file written after `git add -A` never reaches the
PR. The hand-off sequence itself (verify → marker → commit → push → `gh pr create` → manifest) is
otherwise unchanged; D-046 exists because it broke once.

**Revisit if:** the token audit shows the injected block is crowding out the ticket, in which case
PROJECT.md is the first thing to pare — with measurements. Or if `MEMORY/runs/` is routinely
non-empty, which means wrap-up is not running and the curation owner needs to change rather than the
format.
