# D-059: Epic area drag-to-resize uses a CSS custom property driven by a pointer-capture handle; height persisted to `localStorage` (#249)

> _Renumbered D-058 → D-059 (2026-07-17): this number collided with the queue-model D-058 (#259, referenced across the code + PRs). This older UI decision took the new number; the queue-model kept D-058._

**Decision:** The horizontal divider between the Epic band (row 2) and the Ticket band on the board (now row 4) is made resizable by inserting an 8px grid row (row 3) containing a full-width `<div class="epic-resize-handle">` element. Dragging it updates a `--epic-area-height` CSS custom property on `.board`; the epic cells' `max-height` is driven by that variable. The chosen pixel height is saved to `localStorage` under `task-monitor:epic-area-height`.

**Alternatives considered:** (a) overlay an absolutely-positioned handle on the epic cell's bottom border — avoids touching the grid but requires knowing the epic band's rendered position at runtime; (b) derive height from mouse position relative to the board element — equivalent complexity, less composable. The explicit grid row is the most straightforward because the handle becomes a real grid participant instead of a positioned overlay.

**Why pointer capture:** `HTMLElement.setPointerCapture()` redirects all pointer events to the handle element for the lifetime of a drag, so `onpointermove`/`onpointerup` handlers on the handle itself receive events even when the pointer moves above/below it quickly. No global `window` listeners needed.

**Clamping:** Heights are clamped to [36px, 600px] via `clampEpicHeight()` in `board-logic.ts` (tested in `board-logic.spec.ts`). 36px is the epic cell's `min-height`; 600px is a generous ceiling.
