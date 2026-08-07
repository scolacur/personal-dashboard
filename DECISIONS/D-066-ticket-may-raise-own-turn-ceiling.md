# D-066: A ticket may raise its own turn ceiling, bounded — and decomposing stays preferred

**Decision:** `agent_tickets.max_turns` is a nullable per-ticket run ceiling; NULL means "inherit the
loop's env default", which stays authoritative for ~every ticket. The loop uses
`candidate.maxTurns ?? config.robot.maxTurns` and records the **effective** value on the run row and
the `robot_dispatched` event. Overrides are bounded by `ROBOT_MAX_TURNS_LIMIT` (200) and **rejected**
above it, not clamped. The Refine agent may propose one, but only after arguing the work cannot be
decomposed further. Shipped in PD-432.

**Reasoning:**

- **The failure it fixes is expensive and opaque.** A ticket that needs more turns than the global
  has no way to say so: the run burns its whole budget, ends with no green verify, and parks with no
  PR (D-046) — observed three times on 2026-07-29 (PD-412, PD-420) on the same oversized ticket.
- **Nullable, not a per-ticket copy of the default.** Storing 50 on every ticket would freeze today's
  default into thousands of rows and make changing it a migration. NULL keeps one source of truth.
- **Rejected, not clamped, above the bound.** A silently-lowered ceiling looks accepted and behaves
  as something else; whoever asked for 5000 needs to learn the bound exists. The bound also has to
  hold against a *Refine estimate*, not just a human — an agent writes this field too.
- **Recorded per run, because config is not history.** A run that hit its ceiling is only diagnosable
  if you know which ceiling it had. This also removes PD-230's caveat: the board's `N/M` denominator
  was a shared constant that could not see an override, so it showed the wrong M.
- **Decomposing stays the preferred move.** Raising the cap is the escape hatch. A smaller ticket is
  easier to verify and cheaper to retry, and PR #258's sizing discipline is worth more than the
  convenience of a bigger budget — so the prompt demands an argument, and expects omission on
  virtually every ticket. (PD-477 extends the same estimate *downward*, so an easy ticket does not
  hold a licence it will never need.)
