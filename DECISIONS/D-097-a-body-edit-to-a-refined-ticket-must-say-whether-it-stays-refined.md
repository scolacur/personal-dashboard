# D-097: A body edit to a refined ticket must say whether it stays refined, in the UI as a prompt and in the API as a required field

**Date:** 2026-11-17
**Ticket:** PD-749 (A body edit to a refined ticket must say whether it stays refined), under PD-493 (Task Tracker board), split from PD-396 · **Extends:** [[D-089]] §4 (automate where precise, ask where not) · **Related:** [[D-091]] (robot work enters the Queue only refined), [[D-084]] (approving a Refine writes content, never placement), PD-396 (Surface card actions on ticket detail + prompt-unrefine on edit)

## Context

On 2026-07-17, PD-396 decided that saving an edit to a refined ticket's body should prompt "Mark
this unrefined?" (default yes). [[D-089]] §4 generalised the reasoning: a membership change is a
precise trigger, so it un-refines an Epic automatically; a body edit ranges from a typo to a
rewrite, so the board has to ask.

That prompt was never built: PD-396 is still in backlog, bundled with unrelated card actions. So on
2026-11-17 every body edit silently kept `refined`. Steve noticed when three queued Habit Tracker
tickets (PD-724, PD-725, PD-726) had their Task sections extended through the API and stayed refined
and queued.

The decided prompt also only ever covered the **UI**. A `PATCH` from an agent or a script has no
prompt, so even with PD-396 built, the path that edits bodies most often would bypass it.

## Decision

1. **The UI prompt is built as decided in PD-396**: on the card and the detail page, saving a
   changed body on a refined ticket asks "Mark this unrefined?", default **yes**.
2. **The API requires the same choice.** A `PATCH` that changes the body of a refined ticket must
   carry an explicit `refined` (`true` to keep, `false` to clear). Without it, the server refuses
   with **409 `REFINED_CHOICE_REQUIRED`**, and refuses rather than defaulting, so a caller can never
   un-refine or keep by accident. A body that is byte-identical to the stored one is not a change.
3. **Both paths log the outcome** with [[D-089]] §8's events: `refine_kept` or
   `refine_invalidated { cause: 'body' }`. That makes the decline rate measurable, and a near-zero
   rate is the signal to make it automatic.
4. **On an Epic, clearing goes through the existing invalidation**: `refine_stale` is set and armed
   members are un-armed ([[D-089]] §6), exactly as a membership change does.
5. **Un-refining a queued ticket does not dequeue it.** The loop skips it as queued-but-unrefined
   ([[D-091]]) until it is re-marked.
6. **Server-internal writes that already state `refined` are unaffected**: approving a Refine
   ([[D-084]]) and Populate.

## Alternatives rejected

- **Silently keep `refined`** (the behaviour before this decision). The flag then asserts something
  about a body nobody re-read, which is the stale claim [[D-091]] exists to stop being queued.
- **Always un-refine on any body edit.** [[D-089]] §4 already rejected this: a typo fix would cost a
  re-mark every time, and the decline rate is exactly the measurement that should decide it.
- **API defaults to un-refining when unstated.** Safe in direction, but it un-refines silently, and
  queued work would stall with no one having chosen that. A refusal makes every caller decide
  once, in code, where the choice can be read.
- **Prompt in the UI only** (PD-396 as written). It leaves the agent and script path, the most
  frequent body editor, with no rule at all.

## Consequences

- PD-396 loses its prompt-unrefine bullet, which moves to PD-749.
- Any agent or script that edits ticket bodies must now pass `refined`. This includes harness
  sessions using `curl` and Refine-adjacent tooling.
