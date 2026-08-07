# D-068: The Robot's tools are an explicit allowlist, and it may not spawn sub-agents (PD-486)

**Decision:** the Robot's coding session declares its tool surface with the SDK's **`tools`** option —
an allowlist of `Bash`, `BashOutput`, `KillShell`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
`TodoWrite`. **`Task` is not on it**, so a Robot cannot spawn sub-agents. New capability is opt-in.

**Why:** the session previously passed no tool option at all and ran with the SDK's full default set,
so it had `Task` at unbounded depth — a capability nobody chose and no ticket asked for. That was not
merely untidy, because **sub-agent turns are not counted**: assistant messages emitted inside a
sub-agent carry a non-null `parent_tool_use_id` and are excluded from the SDK's `num_turns`, which is
exactly the number [[D-066]]'s per-ticket ceiling enforces and the run row records. One main-loop
turn could spawn a sub-agent that burned arbitrarily many turns invisibly — a hole straight through
the per-ticket ceiling and through the *turns* limb of [[D-064]]'s loop-wide budget. (The *tokens*
limb does see it, since `result.usage` is session-wide, so the loop-wide ceiling was partially blind
and the per-ticket cap fully blind.)

The inversion made it worse: Refine and Audit — both read-only, both human-in-the-loop — already
pinned their tools, while the one **autonomous** job that writes code, runs commands and opens PRs
had no surface at all.

**Allowlist, not denylist,** because a denylist admits every future SDK tool by default, which is
precisely how `Task` arrived unnoticed. Same fail-closed posture as [[D-047]] Tier 1.

**The trap worth recording:** the option to use is **`tools`**, *not* `allowedTools`. `allowedTools`
is a *permission* auto-approve list ("execute without asking"), and the Robot runs
`permissionMode: 'bypassPermissions'` where nothing asks anyway — setting `allowedTools` here would
have looked correct and restricted nothing. `tools` is what "specifies the base set of available
built-in tools". This was nearly shipped the wrong way.

**Two different "depth" concepts, which must never be conflated** (they already were, in discussion):

- **Sub-agent depth** — an agent spawning an agent *within one run*. Governed here, by being set to
  zero. The SDK exposes no depth knob: the cheap mechanical options are **0 or unbounded**, and a
  real depth-1 would require owning the sub-agent definitions so `Task` could be denied in *their*
  surfaces.
- **Ticket-spawn depth** — `agent_queue_depth` in [[D-039]]: a ticket *created by* an agent being
  queued, server-computed and capped at 1. Different mechanism, different enforcement point, still
  unbuilt (PD-244).

Never write bare "depth" in this area.

**Trade-off accepted:** an allowlist can omit something a live run needs, and a missing tool degrades
or hangs a run rather than failing loudly. `BashOutput`/`KillShell` are included for exactly this
reason — they manage a command already started, so without them a backgrounded `npm ci && npm run
verify` becomes unreachable. The surface is asserted in tests, but the real confirmation is PD-468's
first watched run, where it is on the checklist.
