# D-062: A widget card links to a dedicated page; it does not flip

**Decision:** The widget card is a single read-only face whose **header links to the widget's own
page**. Configuration, management UI, and expanded views live on that page. The 3D flip and the
"Expand ↗" link are retired. Shipped for the Dev Ops summary cards in PD-413; **PD-444** converts
the remaining widgets and deletes the flip machinery. Supersedes the rear-panel model PD-28 built.

**Reasoning:**

- **The rear face was always too small for its intended job.** The flip existed to hold
  configuration and an expanded view. In practice those need real room — the BST epic assumed this
  independently (PD-440, "Run history in the expanded widget"), which is a page-sized surface, not
  the back of a card.
- **Two entry points for one destination.** The embedded cards already carried a bottom-left
  "Expand ↗" *and* a flip button. The expand link was absolutely positioned over the card body, so
  on a dense card (the Dev Ops summaries) it overlapped live content.
- **The flip does not generalize.** It swaps the embed's `view` prop between `'generator'` and
  `'manage'`, which only two widgets ever implemented. Every other card flipped to a placeholder
  "Rear panel" face. A control that is dead for most instances is not a shell affordance.
- **A page is addressable; a card face is not.** A widget's manage view can be linked, bookmarked,
  and deep-linked into. Flip state is invisible to the router.

**Consequence:** `WidgetEmbed.flippable` is a transitional flag, not a permanent option — it exists
only so PD-413 could ship without breaking the two widgets that still use the `view` swap. Before
removing a widget's flip, its `variant="page"` view must expose everything the `'manage'` face did.
