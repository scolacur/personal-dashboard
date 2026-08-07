# D-028: Priority is a nullable P0–P5 scale, stored under NOT NULL via a `'none'` sentinel; status locks only when agent-owned

**Decision:** Ticket priority moved from `low|medium|high` to **P0–P5** (P0 most urgent), and may be
**unset**. In the domain/API, unset is `null` (`AgentTicket.priority: TicketPriority | null`).

**Why the `'none'` sentinel (not a real NULL column):** the `agent_tickets.priority` column is
`TEXT NOT NULL`, and the migration framework ([[D-021]]) is strictly additive — it never rebuilds a
populated table. A true `NULL` would require the 12-step SQLite table rebuild, which would
**cascade-delete** every child row (relations/tags/events/reminders all FK `agent_tickets(id)
ON DELETE CASCADE`). Far too risky for a cosmetic nullability change. So unset is stored as the
string `'none'` and mapped at the store boundary: `fromDbPriority('none') → null`,
`toDbPriority(null) → 'none'`. The column stays NOT NULL; the domain still sees clean `null`.

**Data migration is a `migrate()` step, not manual API calls:** `agent_tickets_priority_to_p_levels`
remaps in-place on boot — `high→P1`; `medium` in `in_progress`/`completed`→`P3`; `medium` in
`backlog`→`'none'` (unset); `low→P4`; plus a catch-all (`NOT IN (P0..P5,'none') → P3`) so no legacy
value can survive. Runs once (ledger-guarded), atomic with the deploy, and applies to dev + prod
alike. The committed `tickets.seed.json` was **regenerated from prod** (all 260 live tickets, project
id→slug, priorities remapped by the same rules) so a fresh re-seed restores the *current* board
rather than the stale TODO-derived baseline. The seed now also carries each ticket's **display-id**
(`CreateTicketInput.displayId`): `createTicket` inserts it verbatim and advances the project's `seq`
past it (`seq = MAX(seq, n)`) so later auto-allocations don't collide — so a restore reproduces the
exact ids, not renumbered ones. `seedTickets` carries an expanded warning: the file is a
point-in-time **snapshot** and the importer is a restore-onto-empty tool, never a sync/merge over a
live board — capture the current board by regenerating from the DB, don't hand-edit and re-import.

**Status lock is assignee-gated:** a ticket's status is editable (field + drag) unless it is
**assigned to an agent AND** in `queued/in_progress/in_review/completed` (`isStatusLocked`). Chosen
over pure status-gating so the manually-managed board stays fully editable today (no assignees yet)
and the lock activates automatically once the Sortie flow assigns tickets. New tickets default to
`backlog` status and **unset** priority (assigned deliberately).

**UI:** the card priority chip is now an in-place `<select>` (P0–P5 + None) — native, so it's never
clipped by the board's overflow; an info button by the search bar opens a priority legend
(`PRIORITY_LABELS`/`PRIORITY_DESCRIPTIONS`, exported from `@dashboard/shared`); lanes still band by
priority ([[D-026]] addendum) with unset sorting to the bottom.
