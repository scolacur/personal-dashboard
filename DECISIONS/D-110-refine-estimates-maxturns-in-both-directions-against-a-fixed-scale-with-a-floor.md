# D-110: Refine estimates `maxTurns` in both directions, against a fixed scale with a floor

PD-432 gave a ticket a `max_turns` override and taught the Refine agent to estimate it — but only
*upward*, as an escape hatch for irreducible work. The prompt told the agent to omit it on
virtually every ticket, so in practice every normal ticket ran at the global default
(`ROBOT_MAX_TURNS_DEFAULT`, 50). That left the cheap half of the mechanism unused: a small ticket
that should take ~10 turns still carried a 50-turn licence to spin, and when a run went wrong (a
loop of failing edits, a misread task) the ceiling was the only thing that stopped it — 50 being
5x more burn than that ticket justified, drawn from the same one-plan quota as the whole board
(D-063).

## Decision

The Refine system prompt now asks for a `maxTurns` estimate on **every** proposed ticket, in
**both** directions — a low ceiling for small, well-understood work, not only a raised one for
irreducible work. Omitting `maxTurns` now means "genuinely unsure of the size", not "nothing
unusual". The ceiling is framed as a **budget**, not just a safety valve: sizing it down on an easy
ticket is the same act as sizing it up on a hard one.

**Scale.** The agent anchors on a concrete scale rather than a free guess, grounded in what real
runs cost (a run pays for orientation + grounding reads, `npm ci`, `npm run verify`, and the
commit/push/PR hand-off — not just the edits). `agent_runs` on 2026-11-23: across 47 handed-off
runs the minimum was 12 turns and the mean 51; the smallest tickets landed at 15–17, one-subsystem
work at ~39–47, and server+web vertical slices at 54–100.

- **~25 turns** — a small change: a one-line copy/prompt/config tweak, a single small file, a pure
  helper + its test.
- **~40 turns** — a few files inside one subsystem (a display component + styles + spec; a store
  function + route + test).
- **default 50 (omit)** — a self-contained vertical slice touching server AND web, or any ticket
  that will use most of the budget.

**Floor = 20 (`REFINE_TURN_ESTIMATE_FLOOR`).** Steve picked 20 over the first draft's 15
(2026-11-23): a floor of 15 would put the cheapest real tickets right on their ceiling. An estimate too tight kills a run that would
otherwise have finished, which is more expensive than the turns it saved: pre-checkpoint the whole
run is wasted with no PR (D-046), and even post-checkpoint (D-094) it costs a human Continue
round-trip. Every run also pays a fixed tax (grounding reads + `npm ci` + `npm run verify` +
hand-off) that no estimate can avoid, so below ~20 turns there is little room for the tax plus any real
work. The agent therefore never estimates below the floor, takes its honest mid estimate, rounds
**up**, and leaves headroom — erring high, never fine.

**Raising still costs an argument; lowering does not.** A ceiling *above* the default keeps the
PD-432 requirement: the agent must argue in `rationale` that the work genuinely cannot be
decomposed further. A *lowered* ceiling needs no such argument — it is the ordinary case.

## Why a shared constant passed as a parameter, not imported

The floor lives in `packages/shared/src/task-monitor.ts` as `REFINE_TURN_ESTIMATE_FLOOR` beside
`ROBOT_MAX_TURNS_DEFAULT`/`ROBOT_MAX_TURNS_LIMIT`, so the prompt, the `propose_commit` tool
description, and the tests share one value. It is **guidance to the agent, not an enforced bound** —
the write boundary still accepts `1..ROBOT_MAX_TURNS_LIMIT` (D-066), because a human may deliberately
set a tighter ceiling than the floor the agent is told to stay above.

`refineSystemPrompt` takes the floor as a **parameter** rather than importing it, to preserve that
module's documented invariant: `agent-prompts.ts` imports nothing, which is what keeps it
browser-importable for the Agent Glossary and prevents an import cycle with `task-monitor.ts` (whose
type-only import of `EvaluatorVerdict` relies on `agent-prompts.ts` staying import-free).

## Scope

Prompt + tool-description + glossary wiring only. The `max_turns` column, the loop's use of it, and
the hard safety bound all landed in PD-432. Nothing here dispatches: the estimate is a proposal Steve
approves (D-057), and a human can always edit the number in the create/edit modal.
