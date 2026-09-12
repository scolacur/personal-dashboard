# D-090: The daily log is one shared store in `apps/server/src/lib/` — the first shared *domain* table, and still not a firewall

**Date:** 2026-09-11
**Ticket:** PD-693 · **Related:** [[D-047]] (the guardrail model), [[D-055]] (the Robot's DB-blind uid, the one real firewall here), PD-442 (the shared `job_runs` store), PROJECT.md §5 (no cross-widget imports) and §9 (Firewall vs middleware)

## Context

The 2025 Daily Log is being imported into the dashboard (PD-693). The analysis it exists for —
mood against sleep, lifting against sleep, mood against the previous day's drinking — is
**inherently cross-widget**: the columns belong to four capture surfaces that each have their own
Epic (PD-361 Habit Log, PD-360 Workout Log, PD-51 Sleep Log, PD-95 Mood Tracking).

That collides with the instinct PROJECT.md §5 trains — each widget owns its own tables, namespaced
`music_tracker_*` — and the question was read as "do we relax §5?" **It is not a relaxation, and
that is the first thing this record exists to settle.**

The four capture widgets are also the reason this matters beyond one Epic: they would otherwise
launch empty, and a year of real data means they start with history. **The import format is a
constraint on all four**, not a private detail of the import.

## Decision

### 1. One shared daily-log store, in `apps/server/src/lib/`

A single table holding a day's row, read by every widget that needs it. Not per-widget tables, and
not one widget owning it while others reach in.

### 2. This is §5's documented pattern, not an exception to it

§5 forbids **widget-to-widget imports** — widget A reaching into widget B's folder — and in the same
breath routes shared things to `packages/shared` (types) or `apps/server/src/lib/` (server-side
infrastructure). That is exactly where PD-442 put the shared `job_runs` store.

So a shared store in `lib/` is what the convention already prescribes. Nothing is being weakened,
and a future reader should not treat this as precedent for loosening §5 — the rule that would have
been broken is the one we are *not* doing (option B below).

### 3. It is the first shared **domain** table, and that is the genuinely new part

`job_runs` was infrastructure — machinery about the system. The daily log is *subject matter*. The
distinction has no mechanical consequence today, but it is the reason this decision is written down:
the next person proposing a shared domain table should find this one and follow it, rather than
re-litigating §5 from scratch.

### 4. The access layer is **middleware, not a firewall**

Per §9's Firewall entry: a firewall is a *boundary property*, enforced by something outside the code
so callers cannot decline it. A shared access layer in `lib/` is a *composition pattern* — **any
widget can open its own `better-sqlite3` handle** and bypass it entirely.

So the shared store is **convention enforcement, good and worth having, and not a boundary.** Do not
describe it as one in code comments, docs, or a later decision. The only thing in this system that
genuinely is a firewall is the Robot's DB-blind uid ([[D-055]]), which is enforced by process
privileges rather than by politeness.

The test to apply to any successor proposal: *can the caller decline to use it?* If yes, it is
middleware.

## Alternatives rejected

**A. Per-widget tables, correlate by joining across them.** Every correlation becomes a cross-widget
read, so the coupling §5 exists to prevent arrives anyway — just implicitly, through SQL instead of
an import. It also duplicates the same day's row across four tables, which creates a
write-consistency problem (which copy is right when they disagree?) that a single table does not
have.

**B. One widget owns the table; the others import its accessor.** This is the option that actually
violates §5 — it is precisely the widget-to-widget import the convention forbids — and it makes an
arbitrary widget the owner of data none of them owns more than the others.

**C. Defer the decision until the correlations are built (PD-696).** Rejected because the import
(PD-694) lands the schema, and the four capture widgets backfill from whatever shape it chooses.
By the time the correlations are written the format is already load-bearing in four other Epics.

## Consequences

- PD-694 creates the store in `apps/server/src/lib/`; PD-695, PD-696 and PD-697 read it.
- PD-361, PD-360, PD-51 and PD-95 inherit the import's column shape as a constraint. A change to it
  after they ship is a migration across four widgets, so the shape earns scrutiny at PD-694, not
  later.
- The reading path stays plain `better-sqlite3` in typed functions per §5 — no ORM, no repository
  abstraction, and explicitly no claim that the accessor is a boundary.
