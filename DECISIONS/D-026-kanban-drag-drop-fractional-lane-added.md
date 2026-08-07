# D-026: Kanban is drag-and-drop with fractional `sort_order`; `queued` lane added; status list is the single source of position

**Decision:** The Mission Control board moves tickets by native HTML5 drag-and-drop — within a
lane (reorder) and between lanes (status change) through one code path. The `◀ ▶` arrow buttons
were removed. A `queued` status/lane was added between `ready` and `in_progress`.

**Why / how it works:**
- **One drop path.** A single `ondragover` per lane finds the insertion index by comparing the
  cursor Y to each card's vertical midpoint; `onDrop` computes a new `sortOrder` by **averaging
  the two neighbours** (or stepping ±1 past the ends). `sort_order` is a SQLite `REAL`, so cards
  can be slotted between any two others indefinitely without renumbering.
- **Adding a status is a 3-line change, not a migration.** `status` is a plain `TEXT` column (no
  CHECK constraint) and API validation derives from `TICKET_STATUSES`, so `queued` needed only:
  the shared type/array (`packages/shared/src/agent-dashboard.ts`), the server `ORDER BY` CASE
  (`store.ts`), and the board's `COLUMNS`. `TICKET_STATUSES` order is the authoritative lane order,
  mirrored by the `ORDER BY` CASE — keep the two in sync when adding lanes.
- **Board UX also gained:** a live title+body search filter (`visibleTickets()`), a Condensed
  toggle (hides card bodies), and a clickable priority chip that cycles low→medium→high. `<main>`
  max-width was dropped so the 6-lane board uses full monitor width. "Mission Control" is now the
  page; "Tickets" is a titled section within it (room for future sections).

**Trade-off:** DnD is pointer-only — removing the arrows dropped the keyboard path for moving a
ticket. Acceptable for a single-user personal dashboard; revisit if keyboard/a11y is needed.

**Addendum (priority bands):** Lanes are grouped by priority — high band on top, then medium,
then low (`byStatus` sorts by `PRIORITY_RANK` then `sortOrder`). A card can only be reordered
**within its own band**: `onColumnDragOver` measures the drop point against same-priority cards
only and clamps a past-the-end drop to just before the first lower-priority card, and
`computeSortOrder` averages neighbours **within the band**. Consequence: raising a ticket to high
(via the priority chip) automatically lifts it above every medium/low ticket, because priority is
the primary sort key — no `sortOrder` change needed. Condensed view now defaults **on**.
