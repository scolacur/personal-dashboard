# D-036: `closed` is a separate terminal status from `completed` (PD-81)

**Decision:** Added `'closed'` as a seventh `TicketStatus` value, distinct from `'completed'`. Closed is for manually terminating a ticket for any reason other than successful completion (cancelled, won't-fix, superseded, out-of-scope). `completed` remains the agent-set terminal state (derived from GitHub via the PD-165 poller). The `closed` lane is hidden by default but can be shown via the Lanes menu.

**Alternatives considered:**
- Re-use `completed` with a wontfix badge — rejected because `completed` is externally controlled (poller-set via GitHub label), and conflating "done by agent" with "cancelled by human" muddies both the visual display and the sync logic.
- A soft-archive action — `archiveTicket` already exists for true soft-delete; `closed` is for tickets you want visible (and searchable) in the terminal lane without deleting them.
