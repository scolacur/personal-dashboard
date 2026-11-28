# D-119: Ticket Suggestions are a first-class entity, bundled one-per-PR, approved into a real ticket (PD-979)

**Date:** 2026-11-24 · **Ticket:** PD-979 · **Related:** [[D-076]] (the Evaluator), [[D-080]] (the Epic is the unit of priority/dispatch), [[D-044]] (Refine proposals), [[D-040]] (Notification Center)

## Decision

When the Evaluator reaches the revise round cap (`MAX_EVALUATION_ROUNDS`) with non-blocking
findings still open, the PR ships (PD-977) and the leftovers are **not dropped**: they become a
**Ticket Suggestion** that Steve approves, rejects or modifies in the Decisions inbox.

A Ticket Suggestion is its own persisted entity — a `ticket_suggestions` table plus the shared
`TicketSuggestion` type — rather than a reuse of the Refine proposal model (D-044). A Refine
proposal is owned by a Refine session on one ticket and is consumed by that session; a suggestion
is owned by a shipped PR and creates a *new, unrelated* ticket. Modelling it separately keeps the
`agent_ticket_events`/proposal machinery untouched.

The findings are bundled **one suggestion per PR, not one per finding.** Filing again for the same
PR (dedup key `repo + pr_number`) updates the single pending row rather than adding a second. The
Evaluator can re-run and re-file without the inbox multiplying.

Approving goes through the ordinary `createTicket` path, so **every ticket rule still applies**: the
new ticket starts in `backlog`, unrefined (so normal auto-refine picks it up), and under an Epic —
the source ticket's Epic by default (D-080). Approve and reject are **idempotent and terminal**: a
decided suggestion cannot be decided again, and approving never creates a second ticket.

## Why

- **Separate entity, not a Refine proposal.** The two look superficially alike (a proposed ticket a
  human accepts) but differ in ownership and lifecycle. Overloading the proposal model would have
  coupled the Evaluator's post-PR output to a Refine session that does not exist here.
- **One per PR.** The unit Steve reasons about is "the leftovers from this PR", not each individual
  nit. Dedup on `repo + pr_number` means a re-file is an update, keeping exactly one card per PR.
- **Created through `createTicket`.** Approving must not be able to mint a ticket that skips the
  Epic requirement or lands outside `backlog`; routing it through the one create path is what
  guarantees that, instead of re-deriving the rules at the suggestion boundary.
- **`source` column with room to grow.** Only `evaluator` exists today, but the shape leaves room
  for a Robot-filed suggestion later without a migration.

## Consequences

- Shared shape + pure validators/formatters live in `packages/shared/src/ticket-suggestions.ts`
  (`fileSuggestionError`, `approveSuggestionError`, `resolvedApproval`, `findingLine`) so the store,
  routes and web page read the rules from one place.
- Store: `apps/server/src/widgets/task-monitor/ticket-suggestions.ts`
  (`fileTicketSuggestion` merge-per-PR, `approveTicketSuggestion`, `rejectTicketSuggestion`,
  `listTicketSuggestions`), schema migration in `schema.ts`, routes under the task-monitor base.
- The source ticket's timeline records `suggestion_filed` / `suggestion_approved` (with the created
  id) / `suggestion_rejected`; filing posts a Notification Center entry (`agent_ticket_suggestion`)
  linking to the card, cleared on decision.
- Web: a "Ticket suggestions" section in `/devops/decisions`, beside Visual checks and Refine
  questions; pending suggestions count toward the Decisions badge.

## Not in scope

- Filing suggestions from the Evaluator at the round cap — PD-977 does that.
- Suggestions from any source other than the Evaluator.
