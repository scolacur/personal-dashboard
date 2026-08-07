# D-069: Arrange mode drag-to-reorder uses native HTML5 DnD (commit-on-drop) rather than `svelte-dnd-action` (PD-331)

> **Renumbered 2026-08-07 (PD-490). This shipped as a second D-056.** PR #237 wrote it as D-056
> while PR #235 (Pomodoro `IntervalBars`) was taking the same number in parallel;
> `MEMORY/archive/2026-07-16.md` records the collision being caught and this decision being
> renumbered D-056 → D-057, but that rename never reached the log, and D-057 was later claimed by
> PD-377. So the log carried two D-056 entries for three weeks. It has no citations outside the
> log, so it takes the next free id here rather than disturbing anything. This is the collision
> [[D-070]] exists to make impossible.

**Decision:** D-053 specifies `svelte-dnd-action` for reorder, but adding it would touch `package.json` (dependencies), which is a guarded zone for autonomous agents (CLAUDE.md). Implemented reorder via the browser's native HTML5 drag-and-drop API instead: each widget is `draggable="true"` in arrange mode; `ondragover` highlights the drop target; `ondrop` splices the layouts array and persists to `localStorage`. This is commit-on-drop (the layout updates when the user releases the mouse over a target) rather than live-reorder during drag.

**Alternatives:** `svelte-dnd-action` — better animation and live-reorder during drag, but requires adding a dependency. PD-333 (if/when the DnD libraries are evaluated) could upgrade this surface to `svelte-dnd-action` once the Svelte 5 compat question is answered and the package is added by a human.
