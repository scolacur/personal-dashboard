# D-073: Page membership is user state in the DB, not a registry field; the widget registry declares no placement at all (PD-334)

> **Amends [[D-053]]** on two points: the registry no longer supplies page defaults, and per-page
> layout persistence moves from `localStorage` to the server. Arrange's *scope* (order + size on the
> existing auto-flow grid, never free 2D placement) is unchanged.

**Decision:** registering a widget says **nothing** about where it appears. `WidgetMeta.pages`,
`widgetsForPage()`, `WidgetMeta.system` and `homeWidgets()` are all deleted. Registration puts a
widget in the **widget library** and nothing more; every placement is made by hand and persisted
server-side. Choices from the 2026-08-07 grill:

- **Membership *and* layout live in a new `shell_page_widgets` table** (`page_id`, `widget_id`,
  `sort_order`, `cols`, `rows`; PK `(page_id, widget_id)`), read and written through
  `/api/shell/pages/:id/widgets`. It lives in **`apps/server/src/lib/`**, following the `job_runs`
  store [[D-070]]-era PD-442 established there — cross-cutting infrastructure that belongs to no
  single widget, which is the slot PROJECT.md §5 always reserved ("a future `apps/server/src/lib/`").
  `dashboard:layout:<pageId>` is superseded outright.
- **A widget may sit on many pages but never twice on one** (the PK). Rows naming a widget that is
  no longer registered are ignored on read — the same tolerance `layout.ts` already had.
- **Home becomes an ordinary curated page**, seeded empty. Its auto-catalogue job passes to the
  **Library page**, which is a *derived view* — no membership, no Arrange, not in `pages.ts` — so
  "the library shows every widget" holds by construction, with no surface able to falsify it.
- **One-time server-side seed, guarded by a `shell_meta` flag**, copies today's `pages` values into
  the table before the field is deleted. The guard matters: `bootstrapSchema` runs on every startup,
  so an unguarded seed would resurrect widgets that had been deliberately removed. **Home seeds with
  its current contents, not empty** — Home ends up hand-curated like any other page, but the seed
  itself is a pure no-visible-change migration. Seeding it empty would have left Home blank and
  unfillable across the slices between the store landing and the Add control landing; it is emptied
  by hand once the library exists.
- **Existing `dashboard:layout:*` keys are dropped, not migrated.** Order seeds from registry order,
  sizes from `embed.span`.
- **Add and remove work at every viewport**, unlike Arrange. The Library modal is a **toggle list**
  (checked = on this page), which is the only membership control available below 768px.
- **The client loads every page's membership once at boot** into a single rune-backed store, rather
  than fetching per navigation. The dataset is tiny (one row per widget-per-page — tens of rows), and
  this keeps `canArrange` and the grid **synchronous derivations** exactly as they are against the
  registry today. Per-navigation fetching would have made `canArrange` async — the Arrange button
  popping in late — and forced the grid to distinguish "empty" from "not loaded yet", a state it has
  never needed. Accepted cost: a write from another device isn't seen until reload.
- **Writes are optimistic with revert-and-toast on failure.** A server store can fail where
  `localStorage` effectively could not, and it fails *likely* — every deploy restarts the container.
  `savePageLayout`'s bare `catch {}` was acceptable for `localStorage` and is not acceptable here:
  silently swallowing a failed write means a widget you added is simply gone on next load. The
  Kanban's page-local toast (`devops/task-tracker/+page.svelte`) is promoted to `lib/Toast.svelte` on
  the way — a second caller is this project's stated bar for a shared component (PROJECT.md §5).
- **The Library page mounts widgets live**, not as static preview cards — you see what you would
  actually be adding. Six embedded widgets fetch on visit, against three on Home today. Worth
  revisiting past roughly fifteen embeds, at which point lazy mounting is the upgrade path.

**Why:** the direction came from the observation that a registry field was answering a question only
the user can answer. `layout.ts` was structurally hostile to membership *by design* — saved ids absent
from the registry's page defaults were dropped, and registry ids absent from the saved array were
appended — precisely so a widget added to the registry later would appear on pages already arranged.
Any add/remove feature has to break that merge, which forces the question of what the registry is
*for*. The answer that survived was: it registers what exists, not where things go.

Once placement is entirely user state, `localStorage` stops being defensible. [[D-053]] argued
per-device persistence was "arguably correct" — but that argument was about **column spans**, where a
layout tuned for a wide monitor genuinely needn't follow you to a phone. It does not extend to
**existence**. With no registry defaults left, a browser with no saved state renders every page empty,
so a cache clear or a new device means a blank dashboard rather than a reflowed one. That is a
different class of loss, and it makes the shell's structure content rather than presentation.

The other half of [[D-053]]'s case for `localStorage` — "it needs no backend (the shell owns no DB
tables today — widgets do)" — **has simply expired**. PD-442 landed the shared `job_runs` store in
`apps/server/src/lib/`, so shell-level tables and their route modules are now an established pattern
with a worked example. What was a boundary to cross when D-053 was written is a path to follow now.

**Trade-off:** (1) Turned a frontend-only ticket full-stack — accepted, because the alternative store
fails the phone, which is a stated goal (PROJECT.md §1 lists off-LAN phone access), and the server
work is smaller than it looked now that PD-442 has set the pattern. (2) Deleted `system: true` rather than repurposing it to
hide the Dev Ops summaries from the library — accepted, because a registry that dictates placement
policy is the exact thing being removed, and hiding them would make /devops a page you can empty but
never refill. (3) Dropped existing local layouts instead of migrating them — accepted, because the
seed runs server-side at boot and a client-side import would have to overwrite seeded rows, making
whichever browser loads first the silent winner across devices; the cost is re-arranging once.

**Implications:** PD-334 ships membership only — `shell_page_widgets` keyed by a plain text
`page_id` matching today's `pages.ts`, which stays the hardcoded page registry. **PD-497**
(user-created / reorderable pages) adds `shell_pages` beside it and promotes `page_id` to a real FK
with a delete cascade; the side nav's bottom bar ends up carrying three buttons — **New Page**,
**All Widgets**, **Edit** — of which PD-334 builds only the middle one. The top nav's `canArrange`
becomes async (it reads membership, not the registry), so the nav and the grid need a shared store
rather than two independent fetches. Glossary terms *Widget library* and *Page membership* added to
PROJECT.md §9, and *Arrange mode* re-pointed so membership and layout read as separate axes.
