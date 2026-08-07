# D-050: Embedded live widgets use a registry-provided component + span; generic card is shared chrome (PD-207)

**Decision:** Widgets that want to render live content on the home grid and page stubs register an `embed` object in `widgets.ts` containing a Svelte component and a `{ cols, rows }` grid span. `Widget.svelte` is the shared card chrome: when `embed` is absent it renders the existing link-stub + "Rear panel" placeholder; when present, it renders the component (variant="widget") and uses its own ↺ button to toggle `view` between `'generator'` and `'manage'`, which the component renders accordingly. The grid adds `grid-auto-rows: 140px` so integer-multiple spans give predictable card heights.

**Why:** Widgets are conceptually mini-apps that should be usable directly on the dashboard grid, not just link tiles. The pattern is established with ASG as the first consumer; other widgets can opt in by adding an `embed` entry without touching Widget.svelte or the grids.

**Trade-off:** The embed component API (`variant` / `view` props) is enforced by convention, not TypeScript generics — the registry types `component` loosely to avoid threading per-widget prop types through the generic registry. A future strict-mode approach could use a discriminated union per widget, but at O(10) widgets this adds complexity for no practical benefit.
