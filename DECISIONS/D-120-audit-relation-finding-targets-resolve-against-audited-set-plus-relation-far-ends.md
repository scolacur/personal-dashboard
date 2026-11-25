# D-120: Audit relation-finding targets resolve against the audited set plus existing relation far-ends

**Status:** accepted · **Ticket:** PD-828 ([Audit] Relations as truth, Child A of PD-288)

## Context

The Ticket Audit (D-045) now reads relations as truth and emits advisory relation findings —
`link`, `unlink`, `duplicate` (PD-828). Each such finding names a second ticket (`target`), which
must be resolved to a real ticket id before it is persisted, and a finding whose target cannot be
resolved is dropped so no row is persisted with a null target (Done-When #3).

PD-828 states two things that pull in opposite directions:

1. "Resolve a finding's target displayId → ticket id; DROP a relation finding whose target can't be
   resolved to a **real audited ticket**."
2. "Proactive UNLINK: the agent may flag a stale existing relation (e.g. a `relates`/`duplicates`
   link to an **already archived/closed ticket**) as an `unlink` finding."

An archived/closed ticket is, by definition, **not** in the audit surface
(`getAuditableTickets` filters to active, un-archived tickets). Resolving targets against the
audited set alone would silently drop every proactive unlink — exactly the feature requirement (2)
asks for.

## Decision

A relation finding's `target` is resolved against the **audited ticket set PLUS the far end of
every existing relation on an audited ticket**. Those far ends are already loaded (the audit reads
each audited ticket's relations as truth), so an `unlink`/`duplicate`/`link` whose other end is an
already-archived ticket still resolves its `target_ticket_id`. A target that resolves to neither is
dropped (no null target persisted), honouring Done-When #3's intent — "resolvable to a real ticket
the audit knows about" rather than the narrower literal "audited ticket".

Two supporting rules:

- A `link` finding whose edge (`from → to → type`, both orderings for the symmetric `relates`)
  already exists is dropped — a mechanical backstop for "existing relations are not re-emitted"
  (Done-When #2) that does not rely on the agent obeying the prompt.
- A relation finding whose `relation_type` cannot be resolved is also dropped (`unlink` must name a
  valid existing type; `link` defaults an unknown type to the softer `relates`; `duplicate` is
  always `duplicates`), because a relation finding is only actionable with both ends **and** a type.

Cited in `apps/agent-worker/src/jobs/audit/audit.ts`.

## Consequences

- Proactive unlink of a stale link to an archived/closed ticket works as PD-828 intends.
- No `audit_finding` row is ever persisted with a null `target_ticket_id` or `relation_type`.
- Still fully advisory/read-only — nothing here writes or removes a relation. The Accept/apply path
  that would act on these findings is Child B (blocked by PD-828 + PD-287).
