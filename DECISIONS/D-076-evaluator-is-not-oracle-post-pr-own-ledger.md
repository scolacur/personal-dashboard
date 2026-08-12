# D-076: The Evaluator is not Core's Oracle — it runs post-PR, on its own ledger, and reaches the Robot through the DB (PD-487)

**Decision:** The Evaluator is a **new, control-plane agent**, not Core's Oracle and not a port of
it. It runs in `agent-worker` **after** hand-off, against the open PR, with its **own** table
(`evaluator_runs`), its **own** budget, its **own** model setting, and its **own** master switch. Its
rubric is adapted from Oracle's; nothing else is. A `revise` verdict reaches the Robot as an injected
prompt block, not as a PR comment. It is a reviewer, never a merge gate.

**The Core-vs-control-plane question, answered (PD-487 required this before building):**

- **C-88 does not live in Core's files** — it is a **board** ticket under project 2. Core's docs use
  `D-NNN` for decisions and prose items in `META-TODOS.md`; there is no `C-88` in the repo. The
  ticket's premise that "the evaluator's instructions live there" is false as stated.
- **Core's evaluator is Oracle** (C-63/C-72, shipped): a QA Reviewer *agent* in Core's Tank dispatch
  harness. It grades **sub-agent dispatch output** — SOULs, skills, test results, return envelopes —
  and it has no notion of a git PR, a diff, or a repo. It is markdown invoked by Tank.
- **C-88's own text is entirely about evaluating code**: new components/helpers versus existing
  shared ones, and filing tickets for oversized refactors. It is misfiled; it describes this
  evaluator.
- **So: same principle, different agent.** What PD-487 inherits from Core is
  `PROJECT.md`'s "separate generation from evaluation" — an agent cannot judge its own work. What it
  does NOT inherit is Oracle itself. **No Core change is needed for this ticket.**
- **Oracle's rubric transfers almost 1:1 and is reused.** Oracle evaluates "the original task spec:
  Task, Done When, Constraints", and a Robot ticket is Ready-shaped by construction (PD-177):
  `## Done When` *is* the AC list, `## Out of scope` *is* the constraint list. Oracle's
  SHIP/REVISE/ESCALATE trichotomy also already encodes "reviewer, not gate". Adopting the rubric and
  rejecting the implementation is the whole of the relationship.

**Reasoning:**

- **Post-PR is load-bearing, not convenient.** An in-session evaluator would be sub-agent-shaped, and
  sub-agent turns carry a non-null `parent_tool_use_id` and are excluded from `num_turns` — the
  accounting hole [[D-068]]/PD-486 exists to close. Out here it has its own turn cap and cannot
  inflate the run it is judging.
- **A separate table, not a `kind` column on `agent_runs`.** `budgetUsage()` ([[D-063]]/PD-463) sums
  turns and tokens over **every** row of `agent_runs` with no discriminator. Evaluation spend written
  there would count against the Robot loop's dispatch ceiling — so reviewing PRs could pause
  dispatch, and a busy review day would be indistinguishable from a runaway coding loop. Worse: the
  act of judging a run would inflate the number used to decide whether that run was affordable. A
  `WHERE kind <> 'evaluator'` would also have worked and would have been one forgotten clause away
  from silently restoring the coupling. A separate table cannot be got wrong by omission.
- **The brief reaches the Robot through the DB, not through a PR comment.** A comment looked free —
  Step 0 already has the Robot read `gh pr view --json reviews,comments`. But the rework poll's
  `isTrusted` deliberately ignores unmarked COLLABORATOR comments *so the loop cannot re-trigger
  itself*, and the only way a bot comment triggers rework is by carrying `HUMAN_REPLY_MARKER` — i.e.
  the Evaluator signing its output as a human, on the record a human later reads. Injecting via
  `ResumeContext` instead reuses the path that already exists for exactly this ("context the DB-blind
  session cannot read off the branch", C5/PD-346), keeps PR comments a human channel, and means the
  **Evaluator needs no GitHub write token at all**.
- **Two rounds, then it stops having an opinion.** A `revise` produces a rework, which produces a
  hand-off, which invites another evaluation. Without a counter that is unbounded on both budgets —
  PD-420's failure mode reached by a new road, and the same lesson as the fault-tier retry caps: any
  loop where output feeds back into input needs one. Counted from the last hand-off boundary (the
  same boundary `decideReactivation` uses), so a genuinely new review cycle gets fresh rounds while a
  Robot⇄Evaluator ping-pong inside one cycle terminates.
- **An unreadable evaluation is NOT a `ship`.** A failed fetch, a failed agent turn, or an
  unparseable reply records the error on the Evaluator's ledger and writes **no verdict event** — the
  PR is left exactly as handed off. Treating failure as approval would make a broken Evaluator
  indistinguishable from a satisfied one, which is the worst possible failure direction for a
  reviewer. For the same reason a `null` diff never reaches the agent: an empty diff reads as
  "nothing changed" and would produce a confident, wrong `ship`.
- **A `revise` with no blocking finding is downgraded to `ship`, keeping the findings as advisory.**
  The Evaluator's prose and its structured output disagreed; resolving that by taking the expensive
  branch sends a ticket back with nothing actionable, producing a rework pass that cannot succeed.
  The reverse (a `ship` carrying blocking findings) is deliberately left alone — upgrading it would
  let one mislabelled nitpick trigger rework, the same unactionable outcome from the other side.
- **`blocking` defaults to FALSE when the model omits it.** The expensive action must require an
  explicit assertion.
- **Opus always, and decoupled from `AGENT_WORKER_MODEL`** (Steve's call, 2026-08-12). Redundancy
  detection is whole-codebase judgement, exactly where a weaker model produces confident misses, and
  a false `revise` costs a full rework cycle on both sides. Its own env var so lowering the worker
  default for cost cannot silently downgrade the reviewer.
- **Every verdict is recorded, not just rejecting ones.** A timeline that only shows the Evaluator
  complaining reads as noise; "it reviewed this and was satisfied" is what a human most wants to know
  before merging.
- **Off by default** (`EVALUATOR_ENABLED`), like the Robot loop. Turning on a new autonomous spender
  should be a deliberate deploy, not a side effect of merging the code.

**Implications:** `AGENT_TYPES` gains `evaluator`, so the Agent Glossary (PD-306) grows a tab with no
change to the modal. `ROBOT_EVENT.evaluated` joins the existing `agent_ticket_events` timeline rather
than opening a parallel log. `ResumeContext` gains `evaluatorBrief`, which composes with the
`ask_human` answer rather than overriding it — a human's words outrank an automated reviewer's when
both are present.

**Deferred:** the Evaluator filing its own tickets (the second half of C-88). That would make it the
first agent with **unmediated board write** — the Robot is deliberately DB-blind ([[D-039]]) and
Refine may only *propose* for human approval ([[D-044]]). If the Evaluator files tickets it should go
through the propose-then-approve path, which is its own build and its own decision.

**Revisit if:** the Evaluator's verdicts prove reliable enough to gate on. Nothing here blocks a
merge, and that is deliberate for a component with no track record — the path-guard is the gate, and a
second merge blocker is how a loop deadlocks. A track record is what would change it.
